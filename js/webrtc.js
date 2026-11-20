import { CONFIG } from '../config.js';

// P2P Mesh WebRTC Voice & Video Call manager using DecLoc Chat's encrypted ephemeral Nostr signaling.
// Zero media server needed — audio & video flow directly peer-to-peer between browsers.

export class CallManager {
  constructor({ sendSignal, onStateChange }) {
    this.sendSignal = sendSignal; // async (channelId, payloadObj) => void
    this.onStateChange = onStateChange || (() => {});

    this.activeChannelId = null;
    this.myPubkey = null;
    this.myName = '';
    this.localStream = null;
    this.audioMuted = false;
    this.videoEnabled = false;

    this.peers = new Map(); // remotePubkey -> { pc, stream, name, pendingIce: [] }
    this.activeCallsByRoom = new Map(); // channelId -> Map(pubkey -> { name, ts })
    this.heartbeatTimer = null;

    // Periodically expire stale call announcements
    this.cleanupTimer = setInterval(() => this._pruneStaleAnnouncements(), 5000);
  }

  getActiveCallInfo() {
    if (!this.activeChannelId) return null;
    const remotePeers = [];
    for (const [pubkey, peer] of this.peers.entries()) {
      const hasLiveVideoTrack = peer.stream
        .getVideoTracks()
        .some((tr) => tr.readyState === 'live' && tr.enabled && !tr.muted);
      remotePeers.push({
        pubkey,
        name: peer.name,
        stream: peer.stream,
        videoEnabled: peer.videoEnabled !== undefined ? peer.videoEnabled && peer.stream.getVideoTracks().length > 0 : hasLiveVideoTrack,
        audioMuted: Boolean(peer.audioMuted),
        state: peer.pc?.connectionState || 'connecting',
      });
    }
    return {
      channelId: this.activeChannelId,
      localStream: this.localStream,
      audioMuted: this.audioMuted,
      videoEnabled: this.videoEnabled,
      remotePeers,
    };
  }

  getRoomCallParticipants(channelId) {
    const map = this.activeCallsByRoom.get(channelId);
    if (!map) return [];
    const now = Date.now();
    const out = [];
    for (const [pubkey, info] of map.entries()) {
      if (now - info.ts < 22000) {
        out.push({ pubkey, name: info.name });
      }
    }
    return out;
  }

  async joinCall(channelId, myPubkey, myName, { video = false } = {}) {
    if (this.activeChannelId) {
      await this.leaveCall();
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('MediaDevices API unavailable');
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: video
        ? { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } }
        : false,
    });

    this.activeChannelId = channelId;
    this.myPubkey = myPubkey;
    this.myName = myName;
    this.localStream = stream;
    this.audioMuted = false;
    this.videoEnabled = video;

    await this.sendSignal(channelId, {
      t: 'rtc_join',
      name: myName,
      video,
      muted: false,
    });

    this.heartbeatTimer = setInterval(() => {
      if (!this.activeChannelId) return;
      this.sendSignal(this.activeChannelId, {
        t: 'rtc_beacon',
        name: this.myName,
        video: this.videoEnabled,
        muted: this.audioMuted,
      }).catch(() => {});
    }, 9000);

    this._emit();
  }

  async leaveCall() {
    if (!this.activeChannelId) return;
    const ch = this.activeChannelId;
    this.activeChannelId = null;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;

    for (const peer of this.peers.values()) {
      try {
        peer.pc.close();
      } catch {
        // ignore
      }
    }
    this.peers.clear();

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        track.stop();
      }
      this.localStream = null;
    }

    try {
      await this.sendSignal(ch, { t: 'rtc_leave', name: this.myName });
    } catch {
      // ignore
    }

    this._emit();
  }

  toggleMute() {
    if (!this.localStream) return false;
    this.audioMuted = !this.audioMuted;
    for (const track of this.localStream.getAudioTracks()) {
      track.enabled = !this.audioMuted;
    }
    if (this.activeChannelId) {
      this.sendSignal(this.activeChannelId, {
        t: 'rtc_media',
        video: this.videoEnabled,
        muted: this.audioMuted,
      }).catch(() => {});
    }
    this._emit();
    return this.audioMuted;
  }

  async toggleVideo() {
    if (!this.localStream || !this.activeChannelId) return false;
    const existing = this.localStream.getVideoTracks();
    if (existing.length > 0) {
      this.videoEnabled = !this.videoEnabled;
      for (const t of existing) t.enabled = this.videoEnabled;
      this.sendSignal(this.activeChannelId, {
        t: 'rtc_media',
        video: this.videoEnabled,
        muted: this.audioMuted,
      }).catch(() => {});
      this._emit();
      return this.videoEnabled;
    }
    // Upgrade audio-only call by requesting camera
    const camStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
    });
    const videoTrack = camStream.getVideoTracks()[0];
    this.localStream.addTrack(videoTrack);
    this.videoEnabled = true;

    for (const [remotePubkey, peer] of this.peers.entries()) {
      peer.pc.addTrack(videoTrack, this.localStream);
      await this._sendOffer(remotePubkey, peer);
    }
    this.sendSignal(this.activeChannelId, {
      t: 'rtc_media',
      video: true,
      muted: this.audioMuted,
    }).catch(() => {});
    this._emit();
    return true;
  }

  async handleSignal(channelId, fromPubkey, payload) {
    if (!payload || typeof payload.t !== 'string') return;
    if (fromPubkey === this.myPubkey) return;

    // Record active call announcements for banner display
    if (payload.t === 'rtc_join' || payload.t === 'rtc_beacon') {
      let map = this.activeCallsByRoom.get(channelId);
      if (!map) {
        map = new Map();
        this.activeCallsByRoom.set(channelId, map);
      }
      const hadPeer = map.has(fromPubkey);
      map.set(fromPubkey, { name: String(payload.name || '?').slice(0, 40), ts: Date.now() });
      // Only re-render banner when a new caller appears (prevents periodic <video> flicker)
      if (!hadPeer && this.activeChannelId !== channelId) {
        this._emit();
      }
    } else if (payload.t === 'rtc_leave') {
      const map = this.activeCallsByRoom.get(channelId);
      if (map) {
        map.delete(fromPubkey);
        if (map.size === 0) this.activeCallsByRoom.delete(channelId);
      }
      if (this.activeChannelId === channelId) {
        this._removePeer(fromPubkey);
      }
      this._emit();
      return;
    }

    // Ignore WebRTC signaling if we are not actively in this room's call
    if (this.activeChannelId !== channelId) return;

    // Targeted signals not meant for us
    if (payload.to && payload.to !== this.myPubkey) return;

    if (payload.t === 'rtc_media') {
      const peer = this.peers.get(fromPubkey);
      if (peer) {
        if (typeof payload.video === 'boolean') peer.videoEnabled = payload.video;
        if (typeof payload.muted === 'boolean') peer.audioMuted = payload.muted;
        this._emit();
      }
      return;
    }

    if (payload.t === 'rtc_beacon') {
      const peer = this.peers.get(fromPubkey);
      if (peer) {
        let changed = false;
        if (typeof payload.video === 'boolean' && peer.videoEnabled !== payload.video) {
          peer.videoEnabled = payload.video;
          changed = true;
        }
        if (typeof payload.muted === 'boolean' && peer.audioMuted !== payload.muted) {
          peer.audioMuted = payload.muted;
          changed = true;
        }
        if (changed) this._emit();
      }
      return;
    }

    if (payload.t === 'rtc_join' || payload.t === 'rtc_hello') {
      const peer = this._ensurePeer(fromPubkey, payload.name);
      if (typeof payload.video === 'boolean') peer.videoEnabled = payload.video;
      if (typeof payload.muted === 'boolean') peer.audioMuted = payload.muted;
      if (this.myPubkey > fromPubkey) {
        // Deterministic initiator avoids offer glare
        await this._sendOffer(fromPubkey, peer);
      } else if (payload.t === 'rtc_join') {
        await this.sendSignal(channelId, {
          t: 'rtc_hello',
          to: fromPubkey,
          name: this.myName,
          video: this.videoEnabled,
          muted: this.audioMuted,
        });
      }
      this._emit();
      return;
    }

    if (payload.t === 'rtc_offer' && payload.sdp) {
      const peer = this._ensurePeer(fromPubkey, payload.name);
      try {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        await this._flushPendingIce(peer);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        await this.sendSignal(channelId, {
          t: 'rtc_answer',
          to: fromPubkey,
          name: this.myName,
          sdp: peer.pc.localDescription,
        });
      } catch {
        // ignore transient glare errors
      }
      return;
    }

    if (payload.t === 'rtc_answer' && payload.sdp) {
      const peer = this.peers.get(fromPubkey);
      if (!peer) return;
      try {
        if (peer.pc.signalingState === 'have-local-offer') {
          await peer.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
          await this._flushPendingIce(peer);
        }
      } catch {
        // ignore
      }
      return;
    }

    if (payload.t === 'rtc_ice' && payload.candidate) {
      const peer = this.peers.get(fromPubkey);
      if (!peer) return;
      if (peer.pc.remoteDescription) {
        try {
          await peer.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
        } catch {
          // ignore
        }
      } else {
        peer.pendingIce.push(payload.candidate);
      }
    }
  }

  destroy() {
    clearInterval(this.cleanupTimer);
    this.leaveCall();
  }

  _ensurePeer(remotePubkey, name) {
    const existing = this.peers.get(remotePubkey);
    if (existing) {
      if (name) existing.name = String(name).slice(0, 40);
      return existing;
    }

    const pc = new RTCPeerConnection({ iceServers: CONFIG.ICE_SERVERS });
    const remoteStream = new MediaStream();
    const peer = {
      pc,
      stream: remoteStream,
      name: String(name || '?').slice(0, 40),
      pendingIce: [],
    };
    this.peers.set(remotePubkey, peer);

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        pc.addTrack(track, this.localStream);
      }
    }

    pc.onicecandidate = (evt) => {
      if (evt.candidate && this.activeChannelId) {
        this.sendSignal(this.activeChannelId, {
          t: 'rtc_ice',
          to: remotePubkey,
          candidate: evt.candidate.toJSON(),
        }).catch(() => {});
      }
    };

    pc.ontrack = (evt) => {
      const tracks = evt.streams[0] ? evt.streams[0].getTracks() : [evt.track];
      for (const t of tracks) {
        if (!remoteStream.getTracks().some((rt) => rt.id === t.id)) {
          remoteStream.addTrack(t);
        }
      }
      this._emit();
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this._removePeer(remotePubkey);
      }
      this._emit();
    };

    this._emit();
    return peer;
  }

  async _sendOffer(remotePubkey, peer) {
    if (!this.activeChannelId) return;
    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      await this.sendSignal(this.activeChannelId, {
        t: 'rtc_offer',
        to: remotePubkey,
        name: this.myName,
        sdp: peer.pc.localDescription,
      });
    } catch {
      // ignore
    }
  }

  async _flushPendingIce(peer) {
    const queue = peer.pendingIce.splice(0);
    for (const c of queue) {
      try {
        await peer.pc.addIceCandidate(new RTCIceCandidate(c));
      } catch {
        // ignore
      }
    }
  }

  _removePeer(remotePubkey) {
    const peer = this.peers.get(remotePubkey);
    if (!peer) return;
    try {
      peer.pc.close();
    } catch {
      // ignore
    }
    this.peers.delete(remotePubkey);
  }

  _pruneStaleAnnouncements() {
    const now = Date.now();
    let changed = false;
    for (const [ch, map] of this.activeCallsByRoom.entries()) {
      for (const [pk, info] of map.entries()) {
        if (now - info.ts >= 22000) {
          map.delete(pk);
          changed = true;
        }
      }
      if (map.size === 0) {
        this.activeCallsByRoom.delete(ch);
      }
    }
    if (changed) this._emit();
  }

  _emit() {
    this.onStateChange(this.getActiveCallInfo());
  }
}
