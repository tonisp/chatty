import { CONFIG } from '../config.js';
import { verifyNostrEvent } from './crypto.js';

// Resilient multi-relay Nostr WebSocket pool.
// Handles auto-reconnection, event deduplication, signature verification,
// multi-room subscription, and delivery acknowledgements (OK).

export class RelayPool {
  constructor(relayUrls, { onEvent, onStatusChange, onAck } = {}) {
    this.onEvent = onEvent || (() => {});
    this.onStatusChange = onStatusChange || (() => {});
    this.onAck = onAck || (() => {});

    this.relays = new Map(); // url -> { ws, status, retries, timer }
    this.seenIds = new Set();
    this.channelIds = new Set();
    this.ackCounts = new Map(); // eventId -> Set(relayUrls)
    this.subCounter = 0;
    this.destroyed = false;

    this.setRelays(relayUrls);
  }

  setRelays(urls) {
    const clean = [...new Set(urls.map((u) => u.trim()).filter((u) => u.startsWith('wss://') || u.startsWith('ws://')))];

    // Close removed relays
    for (const [url, state] of this.relays.entries()) {
      if (!clean.includes(url)) {
        clearTimeout(state.timer);
        if (state.ws) {
          state.ws.onclose = null;
          state.ws.close();
        }
        this.relays.delete(url);
      }
    }

    // Add new relays
    for (const url of clean) {
      if (!this.relays.has(url)) {
        const state = { url, ws: null, status: 'connecting', retries: 0, timer: null, subId: null };
        this.relays.set(url, state);
        this._connect(state);
      }
    }
    this._emitStatus();
  }

  setSubscribedChannels(channelIds) {
    const next = new Set(channelIds);
    const changed = next.size !== this.channelIds.size || [...next].some((id) => !this.channelIds.has(id));
    this.channelIds = next;
    if (!changed) return;

    for (const state of this.relays.values()) {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        this._subscribe(state);
      }
    }
  }

  getStatuses() {
    const list = [];
    for (const [url, st] of this.relays.entries()) {
      list.push({ url, status: st.status });
    }
    return list;
  }

  getConnectedCount() {
    let ok = 0;
    for (const st of this.relays.values()) {
      if (st.status === 'connected') ok++;
    }
    return ok;
  }

  publish(event) {
    this._rememberId(event.id);
    const payload = JSON.stringify(['EVENT', event]);
    let sentTo = 0;
    for (const state of this.relays.values()) {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        try {
          state.ws.send(payload);
          sentTo++;
        } catch {
          // ignore send errors; reconnect loop handles it
        }
      }
    }
    return sentTo;
  }

  destroy() {
    this.destroyed = true;
    for (const state of this.relays.values()) {
      clearTimeout(state.timer);
      if (state.ws) {
        state.ws.onclose = null;
        state.ws.close();
      }
    }
    this.relays.clear();
  }

  _connect(state) {
    if (this.destroyed) return;
    clearTimeout(state.timer);
    state.status = 'connecting';
    this._emitStatus();

    let ws;
    try {
      ws = new WebSocket(state.url);
    } catch {
      state.status = 'disconnected';
      this._scheduleReconnect(state);
      return;
    }
    state.ws = ws;

    const connectTimeout = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }, 8000);

    ws.onopen = () => {
      clearTimeout(connectTimeout);
      state.status = 'connected';
      state.retries = 0;
      this._emitStatus();
      this._subscribe(state);
    };

    ws.onmessage = (evt) => {
      this._handleMessage(state, evt.data);
    };

    ws.onerror = () => {
      clearTimeout(connectTimeout);
    };

    ws.onclose = () => {
      clearTimeout(connectTimeout);
      if (state.ws !== ws) return;
      state.ws = null;
      state.status = 'disconnected';
      this._emitStatus();
      this._scheduleReconnect(state);
    };
  }

  _scheduleReconnect(state) {
    if (this.destroyed || !this.relays.has(state.url)) return;
    const delay = Math.min(30000, 1200 * Math.pow(1.8, state.retries)) + Math.floor(Math.random() * 600);
    state.retries++;
    state.timer = setTimeout(() => this._connect(state), delay);
  }

  _subscribe(state) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;

    if (state.subId) {
      try {
        state.ws.send(JSON.stringify(['CLOSE', state.subId]));
      } catch {
        // ignore
      }
      state.subId = null;
    }

    const ids = [...this.channelIds];
    if (ids.length === 0) return;

    const subId = `kaja_${++this.subCounter}`;
    state.subId = subId;

    const historyFilter = {
      kinds: [CONFIG.MSG_KIND],
      '#e': ids,
      limit: CONFIG.HISTORY_LIMIT,
    };
    const ephemeralFilter = {
      kinds: [CONFIG.EPHEMERAL_KIND],
      '#e': ids,
      since: Math.floor(Date.now() / 1000) - 30,
    };

    try {
      state.ws.send(JSON.stringify(['REQ', subId, historyFilter, ephemeralFilter]));
    } catch {
      // ignore
    }
  }

  async _handleMessage(state, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(msg) || msg.length < 2) return;

    const type = msg[0];
    if (type === 'EVENT' && msg[2]) {
      const ev = msg[2];
      if (!ev || typeof ev.id !== 'string') return;
      if (this.seenIds.has(ev.id)) return;
      this._rememberId(ev.id);

      const valid = await verifyNostrEvent(ev);
      if (!valid) return;

      this.onEvent(ev, state.url);
    } else if (type === 'OK' && typeof msg[1] === 'string') {
      const eventId = msg[1];
      const accepted = Boolean(msg[2]);
      if (accepted) {
        let set = this.ackCounts.get(eventId);
        if (!set) {
          set = new Set();
          this.ackCounts.set(eventId, set);
          if (this.ackCounts.size > 500) {
            const first = this.ackCounts.keys().next().value;
            this.ackCounts.delete(first);
          }
        }
        set.add(state.url);
        this.onAck(eventId, set.size, state.url);
      }
    }
  }

  _rememberId(id) {
    this.seenIds.add(id);
    if (this.seenIds.size > 5000) {
      const first = this.seenIds.values().next().value;
      this.seenIds.delete(first);
    }
  }

  _emitStatus() {
    this.onStatusChange(this.getStatuses());
  }
}
