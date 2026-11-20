import { CONFIG } from '../config.js';
import { createTranslator } from './i18n.js';
import {
  hasWebCrypto,
  sha256Hex,
  deriveRoomSecrets,
  deriveRoomIdentity,
  encryptRoomPayload,
  decryptRoomPayload,
  signNostrEvent,
  generatePassphrase,
  encodeInviteUrl,
  decodeInviteHash,
  shortFingerprint,
  colorFromPubkey,
} from './crypto.js';
import {
  loadSettings,
  saveSettings,
  getAllRooms,
  saveRoom,
  deleteRoom,
  saveMessage,
  getRoomMessages,
  exportBackup,
  clearAllData,
} from './storage.js';
import { RelayPool } from './nostr.js';
import { CallManager } from './webrtc.js';

const QUICK_EMOJIS = ['😀', '😂', '❤️', '👍', '🎉', '🔥', '😎', '🤔', '🙏', '👋', '😮', '😢', '🚀', '✨', '💯', '🤝', '👀', '☕'];
const REACT_EMOJIS = ['👍', '❤️', '😂', '🎉'];

const $ = (id) => document.getElementById(id);

let settings = loadSettings();
let t = createTranslator(settings.lang);
let pool = null;
let callManager = null;

// In-memory runtime state per joined room:
// channelId -> { room, aesKey, identity, messages: Map<id, msg>, reactions: Map<targetId, Map<emoji, Set<pubkey>>>, presence: Map<pubkey, {name, ts}>, typing: Map<pubkey, {name, ts}> }
const roomsState = new Map();
let activeChannelId = null;
let replyTarget = null; // { id, name, text }
let pendingInvite = null;
let lastTypingSentAt = 0;
let invitePassVisible = false;
const appBootSec = Math.floor(Date.now() / 1000);
let audioCtx = null;

// --- Boot ---

async function init() {
  applyTheme();
  applyI18n();
  setupEmojiPopover();
  bindEvents();

  if (!hasWebCrypto()) {
    showToast(t('insecureContextWarn'), 7000);
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  // Capture any #join=... invite from URL immediately and strip hash from bar
  pendingInvite = consumeInviteFromUrl();

  // Optional front-door gate configured in config.js
  if (CONFIG.SITE_PASSCODE_SHA256 && !settings.gatePassed) {
    showOverlay('gateOverlay');
    $('gateInput').focus();
    return;
  }

  await continueBootAfterGate();
}

async function continueBootAfterGate() {
  if (!settings.name) {
    openWelcomeOverlay();
    return;
  }
  await startApp();
}

function consumeInviteFromUrl() {
  const parsed = decodeInviteHash(window.location.hash);
  if (parsed) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  return parsed;
}

function openWelcomeOverlay() {
  $('welcomeAppName').textContent = CONFIG.APP_NAME;
  $('welcomeLangBtn').textContent = settings.lang === 'et' ? 'EN' : 'ET';
  if (pendingInvite) {
    $('welcomeInviteBanner').classList.remove('hidden');
    $('welcomeInviteRoom').textContent = pendingInvite.name;
    $('welcomeSubmitBtn').textContent = t('joinInvitedBtn');
  } else {
    $('welcomeInviteBanner').classList.add('hidden');
    $('welcomeSubmitBtn').textContent = t('startBtn');
  }
  showOverlay('welcomeOverlay');
  $('welcomeNameInput').focus();
}

async function startApp() {
  $('sidebarUserName').textContent = settings.name;
  $('appTitle').textContent = CONFIG.APP_NAME;

  // Load saved rooms and derive keys in parallel
  const savedRooms = await getAllRooms();
  for (const r of savedRooms) {
    await hydrateRoom(r);
  }

  // Setup relay pool & WebRTC call manager
  pool = new RelayPool(settings.relays, {
    onEvent: handleIncomingNostrEvent,
    onStatusChange: handleRelayStatusChange,
    onAck: handleEventAck,
  });

  callManager = new CallManager({
    sendSignal: sendRoomEphemeral,
    onStateChange: renderCallUI,
  });

  // Auto-join pending invite link if user opened one
  if (pendingInvite) {
    const inv = pendingInvite;
    pendingInvite = null;
    if (inv.relays && inv.relays.length > 0) {
      const merged = [...new Set([...settings.relays, ...inv.relays])];
      settings.relays = merged;
      saveSettings(settings);
      pool.setRelays(merged);
    }
    const chId = await joinOrCreateRoom(inv.name, inv.passphrase);
    if (chId) selectRoom(chId);
  } else if (settings.lastRoomId && roomsState.has(settings.lastRoomId)) {
    selectRoom(settings.lastRoomId);
  } else if (roomsState.size > 0) {
    const first = [...roomsState.keys()][0];
    selectRoom(first);
  }

  syncSubscriptions();
  renderRoomList();
  updateTabTitle();

  // Presence heartbeat & pruning
  setInterval(() => {
    if (activeChannelId) announcePresence(activeChannelId, 'online');
  }, 20000);

  setInterval(() => {
    pruneEphemeralStates();
  }, 4000);
}

// --- Room Hydration & Joining ---

async function hydrateRoom(room) {
  if (roomsState.has(room.channelId)) return roomsState.get(room.channelId);

  const secrets = await deriveRoomSecrets(room.name, room.passphrase);
  const identity = await deriveRoomIdentity(settings.masterSeed, secrets.channelId);

  const stored = await getRoomMessages(secrets.channelId);
  const msgMap = new Map();
  const reactMap = new Map();

  for (const item of stored) {
    if (item.type === 'react') {
      applyReactionInMemory(reactMap, item);
    } else {
      msgMap.set(item.id, item);
    }
  }

  const state = {
    room: { ...room, channelId: secrets.channelId },
    aesKey: secrets.aesKey,
    identity,
    messages: msgMap,
    reactions: reactMap,
    presence: new Map(),
    typing: new Map(),
  };
  roomsState.set(secrets.channelId, state);
  return state;
}

async function joinOrCreateRoom(roomName, passphrase) {
  const cleanName = roomName.trim();
  if (!cleanName || !passphrase) return null;

  const secrets = await deriveRoomSecrets(cleanName, passphrase);
  let state = roomsState.get(secrets.channelId);
  if (!state) {
    const roomObj = {
      channelId: secrets.channelId,
      name: cleanName,
      passphrase,
      joinedAt: Math.floor(Date.now() / 1000),
      lastActivity: Math.floor(Date.now() / 1000),
      lastReadAt: 0,
      lastPreview: '',
    };
    await saveRoom(roomObj);
    state = await hydrateRoom(roomObj);
    syncSubscriptions();
  }
  renderRoomList();
  return secrets.channelId;
}

function syncSubscriptions() {
  if (!pool) return;
  pool.setSubscribedChannels([...roomsState.keys()]);
}

function selectRoom(channelId) {
  const state = roomsState.get(channelId);
  if (!state) return;

  if (activeChannelId && activeChannelId !== channelId) {
    announcePresence(activeChannelId, 'leave');
  }

  activeChannelId = channelId;
  replyTarget = null;
  renderReplyBar();

  settings.lastRoomId = channelId;
  saveSettings(settings);

  markRoomAsRead(state);

  $('emptyState').classList.add('hidden');
  $('chatView').classList.remove('hidden');
  $('appShell').classList.add('mobile-chat-open');

  $('activeRoomName').textContent = state.room.name;
  renderRoomList();
  renderMessages(true);
  renderOnlineCount();
  renderTypingBar();
  renderCallUI(callManager?.getActiveCallInfo() || null);
  updateTabTitle();

  announcePresence(channelId, 'online');
  if (window.innerWidth > 768) {
    $('messageInput').focus();
  }
}

function markRoomAsRead(state) {
  let maxTs = state.room.lastReadAt || 0;
  for (const m of state.messages.values()) {
    if (m.createdAt > maxTs) maxTs = m.createdAt;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  state.room.lastReadAt = Math.max(maxTs, nowSec);
  saveRoom(state.room).catch(() => {});
}

// --- Nostr Sending & Receiving ---

async function sendTextMessage(text) {
  const state = roomsState.get(activeChannelId);
  if (!state) return;
  const trimmed = text.trim();
  if (!trimmed) return;

  const payload = {
    v: 1,
    t: 'msg',
    name: settings.name,
    text: trimmed,
    ts: Date.now(),
  };
  if (replyTarget) {
    payload.replyTo = {
      id: replyTarget.id,
      name: replyTarget.name,
      text: replyTarget.text.slice(0, 120),
    };
  }

  const content = await encryptRoomPayload(
    state.aesKey,
    state.identity.pubkeyHex,
    state.room.channelId,
    payload
  );

  const ev = await signNostrEvent(
    {
      kind: CONFIG.MSG_KIND,
      tags: [['e', state.room.channelId, '', 'root']],
      content,
    },
    state.identity.privKeyBytes
  );

  const msgObj = {
    id: ev.id,
    channelId: state.room.channelId,
    type: 'msg',
    pubkey: ev.pubkey,
    name: payload.name,
    text: payload.text,
    replyTo: payload.replyTo || null,
    createdAt: ev.created_at,
    ackCount: 0,
  };

  state.messages.set(msgObj.id, msgObj);
  state.room.lastActivity = msgObj.createdAt;
  state.room.lastReadAt = msgObj.createdAt;
  state.room.lastPreview = `${msgObj.name}: ${msgObj.text}`;
  await saveMessage(msgObj);
  await saveRoom(state.room);

  replyTarget = null;
  renderReplyBar();
  renderMessages(true);
  renderRoomList();

  const sentTo = pool ? pool.publish(ev) : 0;
  if (sentTo === 0) {
    showToast(t('errNoRelays'));
  }
}

async function toggleReaction(targetMsgId, emoji) {
  const state = roomsState.get(activeChannelId);
  if (!state) return;

  const existing = state.reactions.get(targetMsgId)?.get(emoji);
  const alreadyReacted = existing?.get(state.identity.pubkeyHex)?.active === true;

  const payload = {
    v: 1,
    t: 'react',
    target: targetMsgId,
    emoji,
    remove: alreadyReacted,
    name: settings.name,
    ts: Date.now(),
  };

  const content = await encryptRoomPayload(
    state.aesKey,
    state.identity.pubkeyHex,
    state.room.channelId,
    payload
  );

  const ev = await signNostrEvent(
    {
      kind: CONFIG.MSG_KIND,
      tags: [['e', state.room.channelId, '', 'root']],
      content,
    },
    state.identity.privKeyBytes
  );

  const reactItem = {
    id: ev.id,
    channelId: state.room.channelId,
    type: 'react',
    pubkey: ev.pubkey,
    target: targetMsgId,
    emoji,
    remove: alreadyReacted,
    createdAt: ev.created_at,
    tsMs: payload.ts,
  };

  applyReactionInMemory(state.reactions, reactItem);
  await saveMessage(reactItem);
  renderMessages(false);

  if (pool) pool.publish(ev);
}

async function sendRoomEphemeral(channelId, payloadObj) {
  const state = roomsState.get(channelId);
  if (!state || !pool) return;
  const content = await encryptRoomPayload(
    state.aesKey,
    state.identity.pubkeyHex,
    channelId,
    { v: 1, ...payloadObj, ts: Date.now() }
  );
  const ev = await signNostrEvent(
    {
      kind: CONFIG.EPHEMERAL_KIND,
      tags: [['e', channelId]],
      content,
    },
    state.identity.privKeyBytes
  );
  pool.publish(ev);
}

function announcePresence(channelId, status = 'online') {
  sendRoomEphemeral(channelId, {
    t: 'presence',
    name: settings.name,
    status,
  }).catch(() => {});
}

function sendTypingSignal(channelId) {
  const now = Date.now();
  if (now - lastTypingSentAt < 2800) return;
  lastTypingSentAt = now;
  sendRoomEphemeral(channelId, {
    t: 'typing',
    name: settings.name,
  }).catch(() => {});
}

async function handleIncomingNostrEvent(ev) {
  const eTag = ev.tags.find((tag) => Array.isArray(tag) && tag[0] === 'e' && typeof tag[1] === 'string');
  if (!eTag) return;
  const channelId = eTag[1];
  const state = roomsState.get(channelId);
  if (!state) return;

  const payload = await decryptRoomPayload(state.aesKey, ev.pubkey, channelId, ev.content);
  if (!payload || typeof payload.t !== 'string') return;

  // --- Ephemeral events (presence, typing, WebRTC signaling) ---
  if (ev.kind === CONFIG.EPHEMERAL_KIND) {
    if (payload.t === 'presence') {
      if (ev.pubkey === state.identity.pubkeyHex) return;
      if (payload.status === 'leave') {
        state.presence.delete(ev.pubkey);
      } else {
        state.presence.set(ev.pubkey, {
          name: String(payload.name || '?').slice(0, 32),
          ts: Date.now(),
        });
      }
      if (channelId === activeChannelId) renderOnlineCount();
      return;
    }

    if (payload.t === 'typing') {
      if (ev.pubkey === state.identity.pubkeyHex) return;
      state.typing.set(ev.pubkey, {
        name: String(payload.name || '?').slice(0, 32),
        ts: Date.now(),
      });
      if (channelId === activeChannelId) renderTypingBar();
      return;
    }

    if (payload.t.startsWith('rtc_') && callManager) {
      await callManager.handleSignal(channelId, ev.pubkey, payload);
      return;
    }
    return;
  }

  // --- Persisted channel messages & reactions (kind 42) ---
  if (ev.kind !== CONFIG.MSG_KIND) return;

  if (payload.t === 'react' && typeof payload.target === 'string' && typeof payload.emoji === 'string') {
    const reactItem = {
      id: ev.id,
      channelId,
      type: 'react',
      pubkey: ev.pubkey,
      target: payload.target,
      emoji: payload.emoji.slice(0, 8),
      remove: Boolean(payload.remove),
      createdAt: ev.created_at,
      tsMs: typeof payload.ts === 'number' ? payload.ts : ev.created_at * 1000,
    };
    applyReactionInMemory(state.reactions, reactItem);
    await saveMessage(reactItem);
    if (channelId === activeChannelId) renderMessages(false);
    return;
  }

  if (payload.t === 'msg' && typeof payload.text === 'string') {
    if (state.messages.has(ev.id)) return;

    const isOwn = ev.pubkey === state.identity.pubkeyHex;
    const msgObj = {
      id: ev.id,
      channelId,
      type: 'msg',
      pubkey: ev.pubkey,
      name: String(payload.name || '?').slice(0, 32),
      text: String(payload.text).slice(0, 4000),
      replyTo: payload.replyTo && typeof payload.replyTo.id === 'string'
        ? {
            id: payload.replyTo.id,
            name: String(payload.replyTo.name || '?').slice(0, 32),
            text: String(payload.replyTo.text || '').slice(0, 140),
          }
        : null,
      createdAt: ev.created_at,
      ackCount: 1,
    };

    state.messages.set(msgObj.id, msgObj);
    state.typing.delete(ev.pubkey);

    if (msgObj.createdAt >= (state.room.lastActivity || 0)) {
      state.room.lastActivity = msgObj.createdAt;
      state.room.lastPreview = `${msgObj.name}: ${msgObj.text}`;
    }

    const isViewingRoom = channelId === activeChannelId && !document.hidden;
    if (isViewingRoom) {
      state.room.lastReadAt = Math.max(state.room.lastReadAt || 0, msgObj.createdAt);
    }

    await saveMessage(msgObj);
    await saveRoom(state.room);

    if (channelId === activeChannelId) {
      const container = $('messagesContainer');
      const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
      renderMessages(nearBottom || isOwn);
      renderTypingBar();
    }
    renderRoomList();
    updateTabTitle();

    // Notify only for genuinely live incoming messages from others
    const isLive = ev.created_at >= appBootSec - 5;
    if (!isOwn && isLive) {
      if (settings.sound) playSoftChime();
      if (document.hidden && settings.notifications && 'Notification' in window && Notification.permission === 'granted') {
        try {
          const notif = new Notification(`${state.room.name} — ${msgObj.name}`, {
            body: msgObj.text.slice(0, 140),
            icon: './icon.svg',
            tag: channelId,
          });
          notif.onclick = () => {
            window.focus();
            selectRoom(channelId);
          };
        } catch {
          // ignore
        }
      }
    }
  }
}

function applyReactionInMemory(reactMap, item) {
  // Sort order matters for toggle; track latest per (target, emoji, pubkey)
  let byEmoji = reactMap.get(item.target);
  if (!byEmoji) {
    byEmoji = new Map();
    reactMap.set(item.target, byEmoji);
  }
  let byUser = byEmoji.get(item.emoji);
  if (!byUser) {
    byUser = new Map(); // pubkey -> { active, ts }
    byEmoji.set(item.emoji, byUser);
  }
  const prev = byUser.get(item.pubkey);
  const tsVal = item.tsMs ?? item.createdAt * 1000;
  if (!prev || tsVal >= prev.ts) {
    byUser.set(item.pubkey, { active: !item.remove, ts: tsVal });
  }
}

function handleEventAck(eventId, count) {
  for (const state of roomsState.values()) {
    const m = state.messages.get(eventId);
    if (m) {
      m.ackCount = Math.max(m.ackCount || 0, count);
      saveMessage(m).catch(() => {});
      if (state.room.channelId === activeChannelId) {
        const el = document.querySelector(`[data-ack-id="${eventId}"]`);
        if (el) {
          el.textContent = count >= 2 ? '✓✓' : '✓';
          el.title = t('sentConfirmed', count);
        }
      }
      break;
    }
  }
}

function handleRelayStatusChange(statuses) {
  const ok = statuses.filter((s) => s.status === 'connected').length;
  const connecting = statuses.some((s) => s.status === 'connecting');
  const total = statuses.length;

  const dot = $('relayStatusDot');
  const txt = $('relayStatusText');
  dot.className = 'dot ' + (ok > 0 ? 'dot-ok' : connecting ? 'dot-warn' : 'dot-err');
  txt.textContent = ok > 0
    ? t('relaysConnected', ok, total)
    : connecting
      ? t('relaysConnecting')
      : t('relaysOffline');

  // Also refresh chips inside Settings modal if open
  const chipList = $('relayStatusList');
  if (chipList && !$('settingsModal').classList.contains('hidden')) {
    renderRelayStatusChips(statuses);
  }
}

function renderRelayStatusChips(statuses) {
  const list = $('relayStatusList');
  list.textContent = '';
  for (const st of statuses) {
    const chip = document.createElement('span');
    chip.className = 'relay-chip';
    const d = document.createElement('span');
    d.className = 'dot ' + (st.status === 'connected' ? 'dot-ok' : st.status === 'connecting' ? 'dot-warn' : 'dot-err');
    const lbl = document.createElement('span');
    lbl.textContent = st.url.replace(/^wss?:\/\//, '');
    chip.append(d, lbl);
    list.appendChild(chip);
  }
}

function pruneEphemeralStates() {
  const now = Date.now();
  let activeChanged = false;
  for (const [chId, state] of roomsState.entries()) {
    for (const [pk, info] of state.presence.entries()) {
      if (now - info.ts > 50000) {
        state.presence.delete(pk);
        if (chId === activeChannelId) activeChanged = true;
      }
    }
    for (const [pk, info] of state.typing.entries()) {
      if (now - info.ts > 4500) {
        state.typing.delete(pk);
        if (chId === activeChannelId) activeChanged = true;
      }
    }
  }
  if (activeChanged) {
    renderOnlineCount();
    renderTypingBar();
  }
}

// --- Rendering ---

function getUnreadCount(state) {
  const readAt = state.room.lastReadAt || 0;
  let count = 0;
  for (const m of state.messages.values()) {
    if (m.pubkey !== state.identity.pubkeyHex && m.createdAt > readAt) {
      count++;
    }
  }
  return count;
}

function updateTabTitle() {
  let totalUnread = 0;
  for (const state of roomsState.values()) {
    totalUnread += getUnreadCount(state);
  }
  document.title = totalUnread > 0 ? `(${totalUnread}) ${CONFIG.APP_NAME}` : CONFIG.APP_NAME;
}

function renderRoomList() {
  const list = $('roomList');
  list.textContent = '';

  const sorted = [...roomsState.values()].sort(
    (a, b) => (b.room.lastActivity || b.room.joinedAt || 0) - (a.room.lastActivity || a.room.joinedAt || 0)
  );

  if (sorted.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'room-empty-hint';
    empty.textContent = t('noRoomsYet');
    list.appendChild(empty);
    return;
  }

  for (const state of sorted) {
    const { room } = state;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'room-item' + (room.channelId === activeChannelId ? ' active' : '');
    btn.addEventListener('click', () => selectRoom(room.channelId));

    const avatar = document.createElement('div');
    avatar.className = 'room-avatar';
    avatar.style.background = colorFromPubkey(room.channelId);
    avatar.textContent = (room.name[0] || '#').toUpperCase();

    const meta = document.createElement('div');
    meta.className = 'room-meta';

    const top = document.createElement('div');
    top.className = 'room-meta-top';
    const nameEl = document.createElement('span');
    nameEl.className = 'room-item-name';
    nameEl.textContent = room.name;
    const timeEl = document.createElement('span');
    timeEl.className = 'room-item-time';
    timeEl.textContent = room.lastActivity ? formatShortTime(room.lastActivity * 1000) : '';
    top.append(nameEl, timeEl);

    const bottom = document.createElement('div');
    bottom.className = 'room-meta-bottom';
    const prevEl = document.createElement('span');
    prevEl.className = 'room-item-preview';
    prevEl.textContent = room.lastPreview || '🔒 ' + t('e2eeBadge');
    bottom.appendChild(prevEl);

    const unread = getUnreadCount(state);
    if (unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'unread-badge';
      badge.textContent = unread > 99 ? '99+' : String(unread);
      bottom.appendChild(badge);
    }

    meta.append(top, bottom);
    btn.append(avatar, meta);
    list.appendChild(btn);
  }
}

function renderMessages(scrollToBottom) {
  const state = roomsState.get(activeChannelId);
  if (!state) return;
  const list = $('messagesList');
  list.textContent = '';

  const msgs = [...state.messages.values()].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)
  );

  if (msgs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = t('historyEmpty');
    list.appendChild(empty);
    return;
  }

  let prevDay = '';
  let prevPubkey = '';
  let prevTs = 0;

  for (const m of msgs) {
    const ms = m.createdAt * 1000;
    const dayKey = new Date(ms).toDateString();
    if (dayKey !== prevDay) {
      const divider = document.createElement('div');
      divider.className = 'date-divider';
      divider.textContent = formatDateHeading(ms);
      list.appendChild(divider);
      prevDay = dayKey;
      prevPubkey = '';
    }

    const isOwn = m.pubkey === state.identity.pubkeyHex;
    const grouped = m.pubkey === prevPubkey && m.createdAt - prevTs < 180;
    prevPubkey = m.pubkey;
    prevTs = m.createdAt;

    const row = document.createElement('div');
    row.className = `msg-row${isOwn ? ' own' : ''}${grouped ? ' grouped' : ''}`;
    row.dataset.msgId = m.id;

    if (!grouped && !isOwn) {
      const author = document.createElement('div');
      author.className = 'msg-author';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'msg-author-name';
      nameSpan.style.color = colorFromPubkey(m.pubkey);
      nameSpan.textContent = m.name;
      const fpSpan = document.createElement('span');
      fpSpan.className = 'msg-author-fp';
      fpSpan.textContent = shortFingerprint(m.pubkey);
      author.append(nameSpan, fpSpan);
      row.appendChild(author);
    }

    const wrap = document.createElement('div');
    wrap.className = 'msg-bubble-wrap';

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    if (m.replyTo) {
      const quote = document.createElement('div');
      quote.className = 'msg-reply-quote';
      quote.addEventListener('click', () => jumpToMessage(m.replyTo.id));
      const qAuthor = document.createElement('span');
      qAuthor.className = 'msg-reply-quote-author';
      qAuthor.textContent = m.replyTo.name;
      const qText = document.createElement('span');
      qText.className = 'msg-reply-quote-text';
      qText.textContent = m.replyTo.text;
      quote.append(qAuthor, qText);
      bubble.appendChild(quote);
    }

    const textContainer = document.createElement('span');
    appendLinkifiedText(textContainer, m.text);
    bubble.appendChild(textContainer);

    // Action buttons (Reply + Quick Reactions)
    const actions = document.createElement('div');
    actions.className = 'msg-actions';

    const replyBtn = document.createElement('button');
    replyBtn.type = 'button';
    replyBtn.className = 'msg-act-btn';
    replyBtn.title = t('replyAction');
    replyBtn.textContent = '↩';
    replyBtn.addEventListener('click', () => {
      replyTarget = { id: m.id, name: m.name, text: m.text };
      renderReplyBar();
      $('messageInput').focus();
    });
    actions.appendChild(replyBtn);

    for (const emoji of REACT_EMOJIS) {
      const rb = document.createElement('button');
      rb.type = 'button';
      rb.className = 'msg-act-btn';
      rb.textContent = emoji;
      rb.addEventListener('click', () => toggleReaction(m.id, emoji));
      actions.appendChild(rb);
    }

    wrap.append(bubble, actions);
    row.appendChild(wrap);

    // Reactions display
    const byEmoji = state.reactions.get(m.id);
    if (byEmoji) {
      const pills = [];
      for (const [emoji, byUser] of byEmoji.entries()) {
        let count = 0;
        let mine = false;
        for (const [pk, st] of byUser.entries()) {
          if (st.active) {
            count++;
            if (pk === state.identity.pubkeyHex) mine = true;
          }
        }
        if (count > 0) pills.push({ emoji, count, mine });
      }
      if (pills.length > 0) {
        const reactBar = document.createElement('div');
        reactBar.className = 'msg-reactions';
        for (const p of pills) {
          const pill = document.createElement('button');
          pill.type = 'button';
          pill.className = 'reaction-pill' + (p.mine ? ' reacted' : '');
          pill.textContent = `${p.emoji} ${p.count}`;
          pill.addEventListener('click', () => toggleReaction(m.id, p.emoji));
          reactBar.appendChild(pill);
        }
        row.appendChild(reactBar);
      }
    }

    // Time & delivery status
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const timeSpan = document.createElement('span');
    timeSpan.textContent = formatClock(ms);
    meta.appendChild(timeSpan);

    if (isOwn) {
      const ackSpan = document.createElement('span');
      ackSpan.dataset.ackId = m.id;
      const ac = m.ackCount || 0;
      ackSpan.textContent = ac >= 2 ? '✓✓' : ac >= 1 ? '✓' : '…';
      ackSpan.title = ac > 0 ? t('sentConfirmed', ac) : t('sentPending');
      meta.appendChild(ackSpan);
    }
    row.appendChild(meta);
    list.appendChild(row);
  }

  if (scrollToBottom) {
    const container = $('messagesContainer');
    container.scrollTop = container.scrollHeight;
  }
}

function appendLinkifiedText(parent, text) {
  const regex = /(https?:\/\/[^\s<>"']+)/g;
  let lastIdx = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parent.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
    }
    let url = match[0];
    let trailing = '';
    while (/[.,!?;:)\]]$/.test(url)) {
      trailing = url.slice(-1) + trailing;
      url = url.slice(0, -1);
    }
    const a = document.createElement('a');
    a.href = url;
    a.textContent = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    parent.appendChild(a);
    if (trailing) parent.appendChild(document.createTextNode(trailing));
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) {
    parent.appendChild(document.createTextNode(text.slice(lastIdx)));
  }
}

function jumpToMessage(msgId) {
  const el = document.querySelector(`.msg-row[data-msg-id="${CSS.escape(msgId)}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('msg-highlight');
  setTimeout(() => el.classList.remove('msg-highlight'), 1400);
}

function renderOnlineCount() {
  const state = roomsState.get(activeChannelId);
  if (!state) return;
  const count = 1 + state.presence.size;
  $('onlineCountText').textContent = t('onlineCount', count);
}

function renderTypingBar() {
  const state = roomsState.get(activeChannelId);
  const bar = $('typingBar');
  if (!state || state.typing.size === 0) {
    bar.classList.add('hidden');
    return;
  }
  const names = [...state.typing.values()].map((x) => x.name);
  bar.textContent =
    names.length === 1
      ? t('typingOne', names[0])
      : names.length === 2
        ? t('typingMany', names[0], names[1])
        : t('typingLots');
  bar.classList.remove('hidden');
}

function renderReplyBar() {
  const bar = $('replyBar');
  if (!replyTarget) {
    bar.classList.add('hidden');
    return;
  }
  $('replyBarAuthor').textContent = t('replyingTo', replyTarget.name);
  $('replyBarText').textContent = replyTarget.text;
  bar.classList.remove('hidden');
}

// --- WebRTC Call UI ---

function renderCallUI(activeCall) {
  const banner = $('callBanner');
  const panel = $('callPanel');

  if (!activeChannelId) {
    banner.classList.add('hidden');
    panel.classList.add('hidden');
    return;
  }

  // Show incoming call banner if peers in this room are on a call and we aren't
  const roomCallers = callManager ? callManager.getRoomCallParticipants(activeChannelId) : [];
  if (!activeCall && roomCallers.length > 0) {
    const names = roomCallers.map((p) => p.name).join(', ');
    $('callBannerText').textContent = t('callBanner', names);
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  if (!activeCall || activeCall.channelId !== activeChannelId) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');
  $('callStatusText').textContent = t('callActive', 1 + activeCall.remotePeers.length);
  $('toggleMuteBtn').textContent = activeCall.audioMuted ? t('unmuteBtn') : t('muteBtn');
  $('toggleCamBtn').textContent = activeCall.videoEnabled ? t('camOffBtn') : t('camOnBtn');

  const grid = $('callMediaGrid');
  grid.textContent = '';

  // Local tile
  grid.appendChild(
    buildMediaTile({
      name: `${settings.name} (${t('youTag')})`,
      pubkey: roomsState.get(activeChannelId)?.identity.pubkeyHex || '0000',
      stream: activeCall.localStream,
      muted: true,
      hasVideo: activeCall.videoEnabled,
    })
  );

  // Remote tiles
  for (const peer of activeCall.remotePeers) {
    const hasVid = peer.stream.getVideoTracks().some((tr) => tr.enabled);
    grid.appendChild(
      buildMediaTile({
        name: peer.name,
        pubkey: peer.pubkey,
        stream: peer.stream,
        muted: false,
        hasVideo: hasVid,
      })
    );
  }
}

function buildMediaTile({ name, pubkey, stream, muted, hasVideo }) {
  const tile = document.createElement('div');
  tile.className = 'media-tile';

  const media = document.createElement(hasVideo ? 'video' : 'audio');
  media.autoplay = true;
  media.playsInline = true;
  media.muted = muted;
  media.srcObject = stream;
  tile.appendChild(media);

  if (!hasVideo) {
    const av = document.createElement('div');
    av.className = 'media-tile-avatar';
    av.style.background = colorFromPubkey(pubkey);
    av.textContent = (name[0] || '?').toUpperCase();
    tile.appendChild(av);
  }

  const lbl = document.createElement('span');
  lbl.className = 'media-tile-label';
  lbl.textContent = name;
  tile.appendChild(lbl);
  return tile;
}

async function startRoomCall(withVideo) {
  const state = roomsState.get(activeChannelId);
  if (!state || !callManager) return;
  try {
    await callManager.joinCall(state.room.channelId, state.identity.pubkeyHex, settings.name, {
      video: withVideo,
    });
  } catch {
    showToast(t('callMediaError'), 5000);
  }
}

// --- Modals & Events ---

function showOverlay(id) {
  $(id).classList.remove('hidden');
}

function hideOverlay(id) {
  $(id).classList.add('hidden');
}

function setupEmojiPopover() {
  const pop = $('emojiPopover');
  pop.textContent = '';
  for (const em of QUICK_EMOJIS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'emoji-btn';
    b.textContent = em;
    b.addEventListener('click', () => {
      const inp = $('messageInput');
      inp.value += em;
      inp.focus();
      pop.classList.add('hidden');
    });
    pop.appendChild(b);
  }
}

function openCreateRoomModal() {
  $('createRoomName').value = '';
  $('createRoomPass').value = generatePassphrase();
  $('createRoomError').classList.add('hidden');
  showOverlay('createRoomModal');
  $('createRoomName').focus();
}

function openJoinRoomModal() {
  $('joinInvitePaste').value = '';
  $('joinRoomName').value = '';
  $('joinRoomPass').value = '';
  $('joinRoomError').classList.add('hidden');
  showOverlay('joinRoomModal');
  $('joinInvitePaste').focus();
}

function openInviteModal() {
  const state = roomsState.get(activeChannelId);
  if (!state) return;

  const customRelays = arraysEqual(settings.relays, CONFIG.DEFAULT_RELAYS) ? null : settings.relays;
  const url = encodeInviteUrl(window.location.href, {
    name: state.room.name,
    passphrase: state.room.passphrase,
    relays: customRelays,
  });

  invitePassVisible = false;
  $('inviteLinkOutput').value = url;
  $('inviteRoomNameText').textContent = state.room.name;
  $('invitePassText').textContent = '••••••••••••';
  $('togglePassRevealBtn').textContent = t('showPassBtn');
  $('inviteMyFingerprint').textContent = shortFingerprint(state.identity.pubkeyHex);

  if (navigator.share) {
    $('shareInviteLinkBtn').classList.remove('hidden');
  } else {
    $('shareInviteLinkBtn').classList.add('hidden');
  }

  showOverlay('inviteModal');
}

function openOnlineModal() {
  const state = roomsState.get(activeChannelId);
  if (!state) return;
  const list = $('onlineList');
  list.textContent = '';

  const rows = [
    { pubkey: state.identity.pubkeyHex, name: `${settings.name} (${t('youTag')})` },
    ...[...state.presence.entries()].map(([pubkey, info]) => ({ pubkey, name: info.name })),
  ];

  for (const r of rows) {
    const item = document.createElement('div');
    item.className = 'online-row';
    const av = document.createElement('div');
    av.className = 'online-avatar';
    av.style.background = colorFromPubkey(r.pubkey);
    av.textContent = (r.name[0] || '?').toUpperCase();
    const info = document.createElement('div');
    const nm = document.createElement('div');
    nm.textContent = r.name;
    const fp = document.createElement('div');
    fp.className = 'muted small mono-input';
    fp.textContent = shortFingerprint(r.pubkey);
    info.append(nm, fp);
    item.append(av, info);
    list.appendChild(item);
  }

  if (rows.length === 1) {
    const note = document.createElement('p');
    note.className = 'hint-text';
    note.textContent = t('noOneOnline');
    list.appendChild(note);
  }

  showOverlay('onlineModal');
}

function openSettingsModal() {
  $('settingsNameInput').value = settings.name;
  $('settingsThemeSelect').value = settings.theme;
  $('settingsLangSelect').value = settings.lang;
  $('settingsSoundCheck').checked = settings.sound;
  $('settingsNotifyCheck').checked = settings.notifications;
  $('settingsRelaysInput').value = settings.relays.join('\n');
  if (pool) renderRelayStatusChips(pool.getStatuses());
  showOverlay('settingsModal');
}

function bindEvents() {
  // Close modals on backdrop click or close buttons
  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => hideOverlay(btn.dataset.closeModal));
  });
  document.querySelectorAll('.overlay').forEach((ov) => {
    if (ov.id === 'welcomeOverlay' || ov.id === 'gateOverlay') return;
    ov.addEventListener('click', (e) => {
      if (e.target === ov) hideOverlay(ov.id);
    });
  });

  // Optional Site Gate
  $('gateForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const hash = await sha256Hex($('gateInput').value);
    if (hash.toLowerCase() === String(CONFIG.SITE_PASSCODE_SHA256).toLowerCase()) {
      settings.gatePassed = true;
      saveSettings(settings);
      hideOverlay('gateOverlay');
      await continueBootAfterGate();
    } else {
      $('gateError').textContent = t('gateWrong');
      $('gateError').classList.remove('hidden');
    }
  });

  // Welcome form
  $('welcomeLangBtn').addEventListener('click', () => {
    settings.lang = settings.lang === 'et' ? 'en' : 'et';
    saveSettings(settings);
    applyI18n();
    openWelcomeOverlay();
  });

  $('welcomeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('welcomeNameInput').value.trim();
    if (!name) {
      $('welcomeError').textContent = t('errEnterName');
      $('welcomeError').classList.remove('hidden');
      return;
    }
    settings.name = name.slice(0, 32);
    saveSettings(settings);
    hideOverlay('welcomeOverlay');
    await startApp();
  });

  // Sidebar & Empty state buttons
  $('openCreateRoomBtn').addEventListener('click', openCreateRoomModal);
  $('emptyCreateBtn').addEventListener('click', openCreateRoomModal);
  $('openJoinRoomBtn').addEventListener('click', openJoinRoomModal);
  $('emptyJoinBtn').addEventListener('click', openJoinRoomModal);
  $('settingsBtn').addEventListener('click', openSettingsModal);
  $('relayStatusBtn').addEventListener('click', openSettingsModal);

  // Mobile back button
  $('mobileBackBtn').addEventListener('click', () => {
    $('appShell').classList.remove('mobile-chat-open');
  });

  // Create room modal
  $('genPassBtn').addEventListener('click', () => {
    $('createRoomPass').value = generatePassphrase();
  });

  $('createRoomForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('createRoomName').value.trim();
    const pass = $('createRoomPass').value;
    if (!name || !pass) {
      $('createRoomError').textContent = t('errFillFields');
      $('createRoomError').classList.remove('hidden');
      return;
    }
    const btn = $('createRoomSubmitBtn');
    btn.disabled = true;
    btn.textContent = t('derivingKeys');
    try {
      const chId = await joinOrCreateRoom(name, pass);
      hideOverlay('createRoomModal');
      if (chId) {
        selectRoom(chId);
        openInviteModal();
      }
    } finally {
      btn.disabled = false;
      btn.textContent = t('createBtn');
    }
  });

  // Join room modal (auto-fill on invite link paste)
  $('joinInvitePaste').addEventListener('input', () => {
    const val = $('joinInvitePaste').value.trim();
    if (!val) return;
    const hashIdx = val.indexOf('#');
    const parsed = decodeInviteHash(hashIdx >= 0 ? val.slice(hashIdx) : val);
    if (parsed) {
      $('joinRoomName').value = parsed.name;
      $('joinRoomPass').value = parsed.passphrase;
      $('joinRoomError').classList.add('hidden');
    }
  });

  $('joinRoomForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    let name = $('joinRoomName').value.trim();
    let pass = $('joinRoomPass').value;
    let extraRelays = null;

    const pasted = $('joinInvitePaste').value.trim();
    if (pasted && (!name || !pass)) {
      const hashIdx = pasted.indexOf('#');
      const parsed = decodeInviteHash(hashIdx >= 0 ? pasted.slice(hashIdx) : pasted);
      if (!parsed) {
        $('joinRoomError').textContent = t('errInvalidInvite');
        $('joinRoomError').classList.remove('hidden');
        return;
      }
      name = parsed.name;
      pass = parsed.passphrase;
      extraRelays = parsed.relays;
    }

    if (!name || !pass) {
      $('joinRoomError').textContent = t('errFillFields');
      $('joinRoomError').classList.remove('hidden');
      return;
    }

    const btn = $('joinRoomSubmitBtn');
    btn.disabled = true;
    btn.textContent = t('derivingKeys');
    try {
      if (extraRelays && extraRelays.length > 0 && pool) {
        settings.relays = [...new Set([...settings.relays, ...extraRelays])];
        saveSettings(settings);
        pool.setRelays(settings.relays);
      }
      const chId = await joinOrCreateRoom(name, pass);
      hideOverlay('joinRoomModal');
      if (chId) selectRoom(chId);
    } finally {
      btn.disabled = false;
      btn.textContent = t('joinBtn');
    }
  });

  // Chat header actions
  $('inviteRoomBtn').addEventListener('click', openInviteModal);
  $('onlinePillBtn').addEventListener('click', openOnlineModal);
  $('voiceCallBtn').addEventListener('click', () => startRoomCall(false));
  $('videoCallBtn').addEventListener('click', () => startRoomCall(true));
  $('joinCallAudioBtn').addEventListener('click', () => startRoomCall(false));
  $('toggleMuteBtn').addEventListener('click', () => callManager?.toggleMute());
  $('toggleCamBtn').addEventListener('click', async () => {
    try {
      await callManager?.toggleVideo();
    } catch {
      showToast(t('callMediaError'), 5000);
    }
  });
  $('hangupBtn').addEventListener('click', () => callManager?.leaveCall());

  $('leaveRoomBtn').addEventListener('click', async () => {
    const state = roomsState.get(activeChannelId);
    if (!state) return;
    if (!confirm(t('leaveRoomConfirm', state.room.name))) return;

    if (callManager?.activeChannelId === activeChannelId) {
      await callManager.leaveCall();
    }
    announcePresence(activeChannelId, 'leave');

    await deleteRoom(activeChannelId);
    roomsState.delete(activeChannelId);
    activeChannelId = null;
    syncSubscriptions();
    renderRoomList();
    updateTabTitle();

    if (roomsState.size > 0) {
      selectRoom([...roomsState.keys()][0]);
    } else {
      $('chatView').classList.add('hidden');
      $('emptyState').classList.remove('hidden');
      $('appShell').classList.remove('mobile-chat-open');
    }
  });

  // Invite modal buttons
  $('copyInviteLinkBtn').addEventListener('click', async () => {
    await copyText($('inviteLinkOutput').value);
    showToast(t('copiedToast'));
  });

  $('shareInviteLinkBtn').addEventListener('click', async () => {
    const state = roomsState.get(activeChannelId);
    if (!state || !navigator.share) return;
    try {
      await navigator.share({
        title: `${CONFIG.APP_NAME} — ${state.room.name}`,
        text: `${state.room.name}`,
        url: $('inviteLinkOutput').value,
      });
    } catch {
      // user cancelled
    }
  });

  $('togglePassRevealBtn').addEventListener('click', () => {
    const state = roomsState.get(activeChannelId);
    if (!state) return;
    invitePassVisible = !invitePassVisible;
    $('invitePassText').textContent = invitePassVisible ? state.room.passphrase : '••••••••••••';
    $('togglePassRevealBtn').textContent = invitePassVisible ? t('hidePassBtn') : t('showPassBtn');
  });

  $('copyCredsBtn').addEventListener('click', async () => {
    const state = roomsState.get(activeChannelId);
    if (!state) return;
    const text = `${t('roomNameLabel')}: ${state.room.name}\n${t('roomPassLabel')}: ${state.room.passphrase}`;
    await copyText(text);
    showToast(t('copiedToast'));
  });

  // Composer & Reply
  $('cancelReplyBtn').addEventListener('click', () => {
    replyTarget = null;
    renderReplyBar();
  });

  $('emojiPickerBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('emojiPopover').classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!$('emojiPopover').contains(e.target) && e.target !== $('emojiPickerBtn')) {
      $('emojiPopover').classList.add('hidden');
    }
  });

  const msgInput = $('messageInput');
  msgInput.addEventListener('input', () => {
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 130) + 'px';
    if (activeChannelId && msgInput.value.trim()) {
      sendTypingSignal(activeChannelId);
    }
  });

  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && window.innerWidth > 768) {
      e.preventDefault();
      $('composerForm').requestSubmit();
    }
  });

  $('composerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const val = msgInput.value;
    if (!val.trim()) return;
    msgInput.value = '';
    msgInput.style.height = 'auto';
    await sendTextMessage(val);
  });

  // Settings form
  $('resetRelaysBtn').addEventListener('click', () => {
    $('settingsRelaysInput').value = CONFIG.DEFAULT_RELAYS.join('\n');
  });

  $('settingsNotifyCheck').addEventListener('change', async (e) => {
    if (e.target.checked && 'Notification' in window && Notification.permission === 'default') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') e.target.checked = false;
    }
  });

  $('settingsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const newName = $('settingsNameInput').value.trim();
    if (newName) settings.name = newName.slice(0, 32);
    settings.theme = $('settingsThemeSelect').value;
    settings.lang = $('settingsLangSelect').value;
    settings.sound = $('settingsSoundCheck').checked;
    settings.notifications = $('settingsNotifyCheck').checked;

    const relays = $('settingsRelaysInput')
      .value.split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('wss://') || l.startsWith('ws://'));
    if (relays.length > 0) settings.relays = [...new Set(relays)];

    saveSettings(settings);
    applyTheme();
    applyI18n();
    $('sidebarUserName').textContent = settings.name;
    if (pool) pool.setRelays(settings.relays);
    if (activeChannelId) {
      announcePresence(activeChannelId, 'online');
      renderOnlineCount();
    }
    renderRoomList();
    hideOverlay('settingsModal');
  });

  // Backup export/import
  $('exportBackupBtn').addEventListener('click', async () => {
    const data = await exportBackup(settings);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kaja-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  $('importBackupBtn').addEventListener('click', () => $('importBackupFile').click());
  $('importBackupFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data?.format !== 'kaja-backup-v1' || !data.profile?.masterSeed) {
        throw new Error('Bad format');
      }
      settings.name = String(data.profile.name || settings.name || 'Kasutaja').slice(0, 32);
      settings.masterSeed = data.profile.masterSeed;
      if (Array.isArray(data.profile.relays) && data.profile.relays.length > 0) {
        settings.relays = data.profile.relays;
      }
      saveSettings(settings);

      roomsState.clear();
      if (Array.isArray(data.rooms)) {
        for (const r of data.rooms) {
          if (r.name && r.passphrase) {
            await joinOrCreateRoom(r.name, r.passphrase);
          }
        }
      }
      if (pool) pool.setRelays(settings.relays);
      syncSubscriptions();
      $('sidebarUserName').textContent = settings.name;
      renderRoomList();
      if (roomsState.size > 0) selectRoom([...roomsState.keys()][0]);
      showToast(t('backupImportedToast'));
      hideOverlay('settingsModal');
    } catch {
      showToast(t('backupInvalidToast'));
    }
  });

  // Clear all data
  $('clearAllBtn').addEventListener('click', async () => {
    if (!confirm(t('clearAllConfirm'))) return;
    if (callManager) callManager.destroy();
    if (pool) pool.destroy();
    await clearAllData();
    window.location.reload();
  });

  // Handle opening an invite hash in an already open tab
  window.addEventListener('hashchange', async () => {
    const inv = consumeInviteFromUrl();
    if (!inv || !settings.name) return;
    if (inv.relays && inv.relays.length > 0 && pool) {
      settings.relays = [...new Set([...settings.relays, ...inv.relays])];
      saveSettings(settings);
      pool.setRelays(settings.relays);
    }
    const chId = await joinOrCreateRoom(inv.name, inv.passphrase);
    if (chId) selectRoom(chId);
  });

  // Mark messages read when returning to tab
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && activeChannelId) {
      const state = roomsState.get(activeChannelId);
      if (state) {
        markRoomAsRead(state);
        renderRoomList();
        updateTabTitle();
      }
    }
  });

  // Clean presence & call teardown on tab close
  window.addEventListener('pagehide', () => {
    if (activeChannelId) announcePresence(activeChannelId, 'leave');
    if (callManager) callManager.leaveCall();
  });
}

// --- Theme, I18n, Formatting, Audio & Clipboard Utilities ---

function applyTheme() {
  const root = document.documentElement;
  if (settings.theme === 'light') {
    root.dataset.theme = 'light';
  } else if (settings.theme === 'dark') {
    root.dataset.theme = 'dark';
  } else {
    const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
    root.dataset.theme = prefersLight ? 'light' : 'dark';
  }
}

function applyI18n() {
  t = createTranslator(settings.lang);
  document.documentElement.lang = settings.lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const val = t(el.dataset.i18n);
    if (typeof val === 'string') el.textContent = val;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const val = t(el.dataset.i18nPlaceholder);
    if (typeof val === 'string') el.placeholder = val;
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const val = t(el.dataset.i18nTitle);
    if (typeof val === 'string') el.title = val;
  });
  if (pool) handleRelayStatusChange(pool.getStatuses());
}

function formatClock(ms) {
  return new Date(ms).toLocaleTimeString(settings.lang === 'et' ? 'et-EE' : 'en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatShortTime(ms) {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return formatClock(ms);
  return d.toLocaleDateString(settings.lang === 'et' ? 'et-EE' : 'en-GB', {
    day: 'numeric',
    month: 'short',
  });
}

function formatDateHeading(ms) {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return t('today');
  const yest = new Date(today);
  yest.setDate(today.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return t('yesterday');
  return d.toLocaleDateString(settings.lang === 'et' ? 'et-EE' : 'en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function playSoftChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, now);
    osc.frequency.setValueAtTime(880, now + 0.065);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.07, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.24);
  } catch {
    // ignore audio autoplay restrictions
  }
}

async function copyText(str) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(str);
  } else {
    const ta = document.createElement('textarea');
    ta.value = str;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function showToast(msg, duration = 2600) {
  const box = $('toastContainer');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

function arraysEqual(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

init();
