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
  generateMasterSeed,
  deriveMasterSeedFromPassword,
  encryptLocalVault,
  decryptLocalVault,
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
  deleteMessagesByIds,
  getRoomMessages,
  exportBackup,
  clearAllData,
} from './storage.js';
import { RelayPool } from './nostr.js';
import { CallManager } from './webrtc.js';
import { EMOJI_CATEGORIES, searchEmojis } from './emojis.js';

const REACT_EMOJIS = ['👍', '❤️', '😂', '🎉'];

const $ = (id) => document.getElementById(id);

let settings = loadSettings();
let t = createTranslator(settings.lang);
let pool = null;
let callManager = null;

// In-memory runtime state per joined room:
const roomsState = new Map();
let activeChannelId = null;
let replyTarget = null; // { id, pubkey, name, text }
let pendingInvite = null;
let lastTypingSentAt = 0;
let invitePassVisible = false;
let selfHostedRelayUrl = null;
let activeMasterSeed = settings.masterSeed || null;
const appBootSec = Math.floor(Date.now() / 1000);
let audioCtx = null;

// Picker & Video Call UI state
let pickerTab = 'emoji'; // 'emoji' | 'gif'
let activeEmojiCat = 'smileys';
let pickerReactTargetMsgId = null;
let gifSearchTimer = null;
let readReceiptTimer = null;
let callLayout = 'compact'; // 'compact' | 'grid' | 'split' | 'spotlight'
let pinnedCallPeer = null; // 'local' | remotePubkey | null

function getDefaultRelays() {
  return selfHostedRelayUrl ? [selfHostedRelayUrl] : [...CONFIG.DEFAULT_RELAYS];
}

async function detectSelfHostedRelay() {
  try {
    const res = await fetch('./decloc-relay.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.selfHostedRelay === true) {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsPath = typeof data.wsPath === 'string' ? data.wsPath : '/relay';
      return `${proto}//${window.location.host}${wsPath}`;
    }
  } catch {
    // Running statically (e.g. GitHub Pages) without local relay
  }
  return null;
}

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
  if (settings.deviceLockEnabled && settings.lockedVault && !activeMasterSeed) {
    openUnlockOverlay();
    return;
  }
  if (!activeMasterSeed) {
    activeMasterSeed = settings.masterSeed || generateMasterSeed();
    settings.masterSeed = activeMasterSeed;
    saveSettings(settings);
  }
  await startApp();
}

function openUnlockOverlay() {
  $('unlockDesc').textContent = t('unlockDesc', settings.name);
  $('unlockPassInput').value = '';
  $('unlockError').classList.add('hidden');
  showOverlay('unlockOverlay');
  $('unlockPassInput').focus();
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
  $('lockAppBtn').classList.toggle('hidden', !settings.deviceLockEnabled);

  // Auto-discover built-in relay when hosted via relay/server.mjs (Termux / self-hosted)
  selfHostedRelayUrl = await detectSelfHostedRelay();
  if (selfHostedRelayUrl && !settings.customRelays) {
    settings.relays = [selfHostedRelayUrl];
    saveSettings(settings);
  }

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
  const identity = await deriveRoomIdentity(activeMasterSeed, secrets.channelId);

  const stored = await getRoomMessages(secrets.channelId);
  const msgMap = new Map();
  const reactMap = new Map();
  const deletedTargets = new Map(); // targetId -> Set(issuerPubkey)
  const verifiedDeletedIds = new Set();

  // Pass 1: load deletion tombstones first so deleted messages cannot reappear
  for (const item of stored) {
    if (item.type === 'del' && Array.isArray(item.targets) && typeof item.pubkey === 'string') {
      for (const tid of item.targets) {
        let issuers = deletedTargets.get(tid);
        if (!issuers) {
          issuers = new Set();
          deletedTargets.set(tid, issuers);
        }
        issuers.add(item.pubkey);
      }
    }
  }

  // Pass 2: load non-deleted messages and purge any leftover zombie messages
  const purgeIds = [];
  for (const item of stored) {
    if (item.type === 'msg' || !item.type) {
      if (deletedTargets.get(item.id)?.has(item.pubkey)) {
        verifiedDeletedIds.add(item.id);
        purgeIds.push(item.id);
      } else {
        msgMap.set(item.id, item);
      }
    }
  }

  // Pass 3: load reactions and read receipts for remaining messages
  const readReceipts = new Map(); // pubkey -> { msgId, msgTs, name, seenAtMs }
  let lastSentReadMsgId = null;

  for (const item of stored) {
    if (item.type === 'react') {
      if (verifiedDeletedIds.has(item.target)) {
        purgeIds.push(item.id);
      } else {
        applyReactionInMemory(reactMap, item);
      }
    } else if (item.type === 'read' && typeof item.pubkey === 'string' && typeof item.msgId === 'string') {
      const seenAtMs = typeof item.seenAtMs === 'number' ? item.seenAtMs : (item.createdAt || 0) * 1000;
      const prev = readReceipts.get(item.pubkey);
      if (!prev || seenAtMs >= prev.seenAtMs) {
        readReceipts.set(item.pubkey, {
          msgId: item.msgId,
          msgTs: Number(item.msgTs || 0),
          name: String(item.name || '?').slice(0, 32),
          seenAtMs,
        });
      }
      if (item.pubkey === identity.pubkeyHex) {
        lastSentReadMsgId = item.msgId;
      }
    }
  }

  if (purgeIds.length > 0) {
    deleteMessagesByIds(purgeIds).catch(() => {});
  }

  const state = {
    room: { ...room, channelId: secrets.channelId },
    aesKey: secrets.aesKey,
    identity,
    messages: msgMap,
    reactions: reactMap,
    readReceipts,
    lastSentReadMsgId,
    deletedTargets,
    verifiedDeletedIds,
    presence: new Map(),
    typing: new Map(),
  };
  recomputeRoomPreview(state);
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
  scheduleReadReceipt(state);
  if (window.innerWidth > 768) {
    $('messageInput').focus();
  }
}

function scheduleReadReceipt(state) {
  clearTimeout(readReceiptTimer);
  readReceiptTimer = setTimeout(() => {
    sendReadReceiptIfNeeded(state).catch(() => {});
  }, 600);
}

function isSafeHttpsUrl(url) {
  if (typeof url !== 'string' || url.length > 2048) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function sendReadReceiptIfNeeded(state) {
  if (!state || !pool || !settings.readReceipts) return;
  if (state.room.channelId !== activeChannelId || document.hidden) return;

  // Find newest message in the room
  let latest = null;
  for (const m of state.messages.values()) {
    if (!latest || m.createdAt > latest.createdAt || (m.createdAt === latest.createdAt && m.id > latest.id)) {
      latest = m;
    }
  }
  if (!latest) return;
  // Do not send read receipts for our own latest message
  if (latest.pubkey === state.identity.pubkeyHex) return;
  if (state.lastSentReadMsgId === latest.id) return;

  state.lastSentReadMsgId = latest.id;
  const nowMs = Date.now();

  const payload = {
    v: 1,
    t: 'read',
    msgId: latest.id,
    msgTs: latest.createdAt,
    name: settings.name,
    ts: nowMs,
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

  await saveMessage({
    id: `read:${state.room.channelId}:${state.identity.pubkeyHex}`,
    channelId: state.room.channelId,
    type: 'read',
    pubkey: state.identity.pubkeyHex,
    msgId: latest.id,
    msgTs: latest.createdAt,
    name: settings.name,
    seenAtMs: nowMs,
    createdAt: ev.created_at,
  });

  pool.publish(ev);
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

async function sendTextMessage(text, gifObj = null) {
  const state = roomsState.get(activeChannelId);
  if (!state) return;
  const trimmed = String(text || '').trim();
  const validGif = gifObj && isSafeHttpsUrl(gifObj.url)
    ? { url: gifObj.url, title: String(gifObj.title || 'GIF').slice(0, 80) }
    : null;
  if (!trimmed && !validGif) return;

  const payload = {
    v: 1,
    t: 'msg',
    name: settings.name,
    text: trimmed,
    ts: Date.now(),
  };
  if (validGif) {
    payload.gif = validGif;
  }
  if (replyTarget) {
    payload.replyTo = {
      id: replyTarget.id,
      pubkey: replyTarget.pubkey || null,
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
    gif: validGif,
    replyTo: payload.replyTo || null,
    createdAt: ev.created_at,
    ackCount: 0,
  };

  state.messages.set(msgObj.id, msgObj);
  state.room.lastActivity = msgObj.createdAt;
  state.room.lastReadAt = msgObj.createdAt;
  state.room.lastPreview = `${msgObj.name}: ${msgObj.text || '[GIF]'}`;
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

function isDeletedForAuthor(state, msgId, authorPubkey) {
  return state.deletedTargets.get(msgId)?.has(authorPubkey) === true;
}

function recomputeRoomPreview(state) {
  let latest = null;
  for (const m of state.messages.values()) {
    if (!latest || m.createdAt > latest.createdAt || (m.createdAt === latest.createdAt && m.id > latest.id)) {
      latest = m;
    }
  }
  if (latest) {
    state.room.lastActivity = latest.createdAt;
    state.room.lastPreview = `${latest.name}: ${latest.text || '[GIF]'}`;
  } else {
    state.room.lastPreview = '';
  }
}

async function applyDeletionInRoom(state, targetIds, issuerPubkey) {
  const removedDbIds = [];
  let changed = false;

  for (const tid of targetIds) {
    let issuers = state.deletedTargets.get(tid);
    if (!issuers) {
      issuers = new Set();
      state.deletedTargets.set(tid, issuers);
    }
    issuers.add(issuerPubkey);

    const existing = state.messages.get(tid);
    // Strict cryptographic ownership check: ONLY the original author can delete their message
    if (existing && existing.pubkey === issuerPubkey) {
      state.messages.delete(tid);
      state.reactions.delete(tid);
      state.verifiedDeletedIds.add(tid);
      removedDbIds.push(tid);
      changed = true;
      if (replyTarget && replyTarget.id === tid) {
        replyTarget = null;
        renderReplyBar();
      }
    }
  }

  if (removedDbIds.length > 0) {
    await deleteMessagesByIds(removedDbIds);
    recomputeRoomPreview(state);
    await saveRoom(state.room);
  }
  return changed;
}

// Delete ONLY the current user's own messages across:
// 1) local IndexedDB & UI,
// 2) Nostr relays via standard NIP-09 (kind 5),
// 3) other participants' browsers (live & offline) via encrypted room tombstone (kind 42, t: 'del').
async function deleteOwnMessages(channelId, requestedIds) {
  const state = roomsState.get(channelId);
  if (!state) return 0;

  const myPubkey = state.identity.pubkeyHex;
  const ownIds = [...new Set(requestedIds)].filter((id) => {
    const m = state.messages.get(id);
    return m && m.pubkey === myPubkey;
  });
  if (ownIds.length === 0) return 0;

  // 1. Remove locally right away
  await applyDeletionInRoom(state, ownIds, myPubkey);

  // Batch into chunks of 100 so relays never reject oversized tag lists
  const CHUNK_SIZE = 100;
  for (let i = 0; i < ownIds.length; i += CHUNK_SIZE) {
    const chunk = ownIds.slice(i, i + CHUNK_SIZE);

    // 2. NIP-09 event deletion request for Nostr relays (kind 5)
    const nip09Ev = await signNostrEvent(
      {
        kind: CONFIG.DELETE_KIND,
        tags: [...chunk.map((id) => ['e', id]), ['k', String(CONFIG.MSG_KIND)]],
        content: '',
      },
      state.identity.privKeyBytes
    );
    if (pool) pool.publish(nip09Ev);

    // 3. Encrypted room tombstone so other devices erase their local IndexedDB copies
    const tombstonePayload = {
      v: 1,
      t: 'del',
      targets: chunk,
      ts: Date.now(),
    };
    const encContent = await encryptRoomPayload(
      state.aesKey,
      myPubkey,
      channelId,
      tombstonePayload
    );
    const delEv = await signNostrEvent(
      {
        kind: CONFIG.MSG_KIND,
        tags: [['e', channelId, '', 'root']],
        content: encContent,
      },
      state.identity.privKeyBytes
    );

    await saveMessage({
      id: delEv.id,
      channelId,
      type: 'del',
      pubkey: myPubkey,
      targets: chunk,
      createdAt: delEv.created_at,
    });

    if (pool) pool.publish(delEv);
  }

  if (channelId === activeChannelId) renderMessages(false);
  renderRoomList();
  updateTabTitle();
  return ownIds.length;
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

  // --- Persisted channel messages, reactions & deletions (kind 42) ---
  if (ev.kind !== CONFIG.MSG_KIND) return;

  if (payload.t === 'del' && Array.isArray(payload.targets)) {
    const targets = payload.targets
      .filter((x) => typeof x === 'string' && /^[0-9a-f]{64}$/i.test(x))
      .slice(0, 500);
    if (targets.length === 0) return;

    await saveMessage({
      id: ev.id,
      channelId,
      type: 'del',
      pubkey: ev.pubkey,
      targets,
      createdAt: ev.created_at,
    });

    const changed = await applyDeletionInRoom(state, targets, ev.pubkey);
    if (changed) {
      if (channelId === activeChannelId) renderMessages(false);
      renderRoomList();
      updateTabTitle();
    }
    return;
  }

  if (payload.t === 'react' && typeof payload.target === 'string' && typeof payload.emoji === 'string') {
    if (state.verifiedDeletedIds.has(payload.target)) return;
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

  if (payload.t === 'read' && typeof payload.msgId === 'string') {
    const seenAtMs = typeof payload.ts === 'number' ? payload.ts : ev.created_at * 1000;
    const msgTs = typeof payload.msgTs === 'number' ? payload.msgTs : ev.created_at;
    const name = String(payload.name || '?').slice(0, 32);
    const prev = state.readReceipts.get(ev.pubkey);
    if (!prev || seenAtMs >= prev.seenAtMs) {
      state.readReceipts.set(ev.pubkey, {
        msgId: payload.msgId,
        msgTs,
        name,
        seenAtMs,
      });
      if (ev.pubkey === state.identity.pubkeyHex) {
        state.lastSentReadMsgId = payload.msgId;
      }
      await saveMessage({
        id: `read:${channelId}:${ev.pubkey}`,
        channelId,
        type: 'read',
        pubkey: ev.pubkey,
        msgId: payload.msgId,
        msgTs,
        name,
        seenAtMs,
        createdAt: ev.created_at,
      });
      if (channelId === activeChannelId) renderMessages(false);
    }
    return;
  }

  if (payload.t === 'msg' && (typeof payload.text === 'string' || (payload.gif && isSafeHttpsUrl(payload.gif.url)))) {
    if (state.messages.has(ev.id)) return;
    // Drop zombie copies from relays that ignored NIP-09 deletion
    if (isDeletedForAuthor(state, ev.id, ev.pubkey)) {
      state.verifiedDeletedIds.add(ev.id);
      return;
    }

    const isOwn = ev.pubkey === state.identity.pubkeyHex;
    const validGif = payload.gif && isSafeHttpsUrl(payload.gif.url)
      ? { url: payload.gif.url, title: String(payload.gif.title || 'GIF').slice(0, 80) }
      : null;
    const msgObj = {
      id: ev.id,
      channelId,
      type: 'msg',
      pubkey: ev.pubkey,
      name: String(payload.name || '?').slice(0, 32),
      text: String(payload.text || '').slice(0, 4000),
      gif: validGif,
      replyTo: payload.replyTo && typeof payload.replyTo.id === 'string'
        ? {
            id: payload.replyTo.id,
            pubkey: typeof payload.replyTo.pubkey === 'string' ? payload.replyTo.pubkey : null,
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
      state.room.lastPreview = `${msgObj.name}: ${msgObj.text || '[GIF]'}`;
    }

    const isViewingRoom = channelId === activeChannelId && !document.hidden;
    if (isViewingRoom) {
      state.room.lastReadAt = Math.max(state.room.lastReadAt || 0, msgObj.createdAt);
    }

    await saveMessage(msgObj);
    await saveRoom(state.room);

    if (isViewingRoom && !isOwn) {
      scheduleReadReceipt(state);
    }

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

  // Compute read-receipt placement: map each user's latest seen marker to the newest message they reached
  const seenByMsgId = new Map(); // msgId -> Array<{ pubkey, name, seenAtMs }>
  const msgById = new Map(msgs.map((m) => [m.id, m]));
  for (const [pk, receipt] of state.readReceipts.entries()) {
    if (pk === state.identity.pubkeyHex) continue;
    let targetMsg = msgById.get(receipt.msgId);
    if (!targetMsg) {
      // Fallback if the exact message was deleted: find newest message at or before msgTs
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].createdAt <= receipt.msgTs) {
          targetMsg = msgs[i];
          break;
        }
      }
    }
    if (!targetMsg) continue;
    // Skip attributing a user as having "seen" their own message when no newer messages exist
    if (targetMsg.pubkey === pk) continue;
    let arr = seenByMsgId.get(targetMsg.id);
    if (!arr) {
      arr = [];
      seenByMsgId.set(targetMsg.id, arr);
    }
    arr.push({ pubkey: pk, name: receipt.name, seenAtMs: receipt.seenAtMs });
  }
  for (const arr of seenByMsgId.values()) {
    arr.sort((a, b) => b.seenAtMs - a.seenAtMs);
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
      const quoteDeleted =
        state.verifiedDeletedIds.has(m.replyTo.id) ||
        (m.replyTo.pubkey && isDeletedForAuthor(state, m.replyTo.id, m.replyTo.pubkey));
      const quote = document.createElement('div');
      quote.className = 'msg-reply-quote';
      if (!quoteDeleted) {
        quote.addEventListener('click', () => jumpToMessage(m.replyTo.id));
      }
      const qAuthor = document.createElement('span');
      qAuthor.className = 'msg-reply-quote-author';
      qAuthor.textContent = m.replyTo.name;
      const qText = document.createElement('span');
      qText.className = 'msg-reply-quote-text' + (quoteDeleted ? ' msg-reply-deleted' : '');
      qText.textContent = quoteDeleted ? t('deletedQuoteText') : m.replyTo.text;
      quote.append(qAuthor, qText);
      bubble.appendChild(quote);
    }

    if (m.text) {
      const textContainer = document.createElement('span');
      appendLinkifiedText(textContainer, m.text);
      bubble.appendChild(textContainer);
    }

    if (m.gif && isSafeHttpsUrl(m.gif.url)) {
      const img = document.createElement('img');
      img.className = 'msg-gif';
      img.src = m.gif.url;
      img.alt = m.gif.title || 'GIF';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      bubble.appendChild(img);
    }

    // Action buttons (Reply + Quick Reactions + Full Emoji Reaction + Own Message Delete)
    const actions = document.createElement('div');
    actions.className = 'msg-actions';

    const replyBtn = document.createElement('button');
    replyBtn.type = 'button';
    replyBtn.className = 'msg-act-btn';
    replyBtn.title = t('replyAction');
    replyBtn.textContent = '↩';
    replyBtn.addEventListener('click', () => {
      replyTarget = { id: m.id, pubkey: m.pubkey, name: m.name, text: m.text || '[GIF]' };
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

    const moreReactBtn = document.createElement('button');
    moreReactBtn.type = 'button';
    moreReactBtn.className = 'msg-act-btn';
    moreReactBtn.title = t('reactMoreAction');
    moreReactBtn.textContent = '＋';
    moreReactBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openPicker({ tab: 'emoji', reactTargetMsgId: m.id });
    });
    actions.appendChild(moreReactBtn);

    if (isOwn) {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'msg-act-btn msg-act-btn-danger';
      delBtn.title = t('deleteMsgAction');
      delBtn.setAttribute('aria-label', t('deleteMsgAction'));
      delBtn.textContent = '🗑';
      delBtn.addEventListener('click', async () => {
        if (!confirm(t('deleteMsgConfirm'))) return;
        const count = await deleteOwnMessages(state.room.channelId, [m.id]);
        if (count > 0) showToast(t('msgDeletedToast'));
      });
      actions.appendChild(delBtn);
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

    // Render subtle "Nähtud" read receipt row underneath the message
    const viewers = seenByMsgId.get(m.id);
    if (viewers && viewers.length > 0) {
      const seenBtn = document.createElement('button');
      seenBtn.type = 'button';
      seenBtn.className = 'msg-seen-bar';
      seenBtn.style.alignSelf = 'flex-end';
      seenBtn.addEventListener('click', () => openSeenModal(viewers));

      const dotsWrap = document.createElement('span');
      dotsWrap.className = 'seen-dots';
      for (const v of viewers.slice(0, 3)) {
        const dot = document.createElement('span');
        dot.className = 'seen-dot';
        dot.style.background = colorFromPubkey(v.pubkey);
        dot.textContent = (v.name[0] || '?').toUpperCase();
        dotsWrap.appendChild(dot);
      }

      const summary = viewers
        .slice(0, 2)
        .map((v) => `${v.name} ${formatSeenTime(v.seenAtMs)}`)
        .join(', ');
      const extra = viewers.length > 2 ? ` +${viewers.length - 2}` : '';
      const txt = document.createElement('span');
      txt.textContent = `✓✓ ${t('seenPrefix')} ${summary}${extra}`;

      seenBtn.append(dotsWrap, txt);
      list.appendChild(seenBtn);
    }
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

// --- WebRTC Call UI (Compact, Grid, Split 50/50, Spotlight + PiP) ---

function setCallLayout(nextLayout) {
  if (!['compact', 'grid', 'split', 'spotlight'].includes(nextLayout)) return;
  callLayout = nextLayout;
  if (callLayout === 'compact' && document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
  renderCallUI(callManager?.getActiveCallInfo() || null);
}

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
    if (document.fullscreenElement === panel) {
      document.exitFullscreen().catch(() => {});
    }
    return;
  }

  panel.classList.remove('hidden');
  panel.classList.remove('call-layout-compact', 'call-layout-grid', 'call-layout-split', 'call-layout-spotlight');
  panel.classList.add(`call-layout-${callLayout}`);

  // Highlight active layout pill
  document.querySelectorAll('.call-layout-switcher .layout-pill').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.layout === callLayout);
  });

  // Show "Back to chat" button in fullscreen modes
  $('callBackToChatBtn').classList.toggle('hidden', callLayout === 'compact');

  const totalCount = 1 + activeCall.remotePeers.length;
  $('callStatusText').textContent = t('callActive', totalCount);
  $('toggleMuteBtn').textContent = activeCall.audioMuted ? t('unmuteBtn') : t('muteBtn');
  $('toggleCamBtn').textContent = activeCall.videoEnabled ? t('camOffBtn') : t('camOnBtn');

  const localTileData = {
    key: 'local',
    name: `${settings.name} (${t('youTag')})`,
    pubkey: roomsState.get(activeChannelId)?.identity.pubkeyHex || '0000',
    stream: activeCall.localStream,
    muted: true,
    isLocal: true,
    audioMuted: activeCall.audioMuted,
    hasVideo: activeCall.videoEnabled,
  };

  const remoteTilesData = activeCall.remotePeers.map((peer) => ({
    key: peer.pubkey,
    name: peer.name,
    pubkey: peer.pubkey,
    stream: peer.stream,
    muted: false,
    isLocal: false,
    audioMuted: Boolean(peer.audioMuted),
    hasVideo: Boolean(peer.videoEnabled),
  }));

  const allTiles = [localTileData, ...remoteTilesData];

  // Ensure pinned peer still exists
  if (pinnedCallPeer && pinnedCallPeer !== 'local' && !remoteTilesData.some((p) => p.key === pinnedCallPeer)) {
    pinnedCallPeer = null;
  }

  const grid = $('callMediaGrid');
  const pipSlot = $('callPipSlot');
  const stripSlot = $('callStripSlot');
  grid.textContent = '';
  pipSlot.textContent = '';
  stripSlot.textContent = '';
  pipSlot.classList.add('hidden');
  stripSlot.classList.add('hidden');

  if (callLayout === 'compact') {
    for (const item of allTiles) {
      grid.appendChild(
        buildMediaTile(item, () => {
          pinnedCallPeer = item.key;
          setCallLayout('spotlight');
        })
      );
    }
    return;
  }

  if (callLayout === 'grid') {
    const cols = totalCount <= 1 ? 1 : totalCount <= 4 ? 2 : 3;
    grid.style.setProperty('--grid-cols', String(cols));
    for (const item of allTiles) {
      grid.appendChild(
        buildMediaTile(item, () => {
          pinnedCallPeer = item.key;
          setCallLayout('spotlight');
        })
      );
    }
    return;
  }

  if (callLayout === 'split') {
    // 50/50 split: primary remote peer + your own screen
    const primaryRemote =
      remoteTilesData.find((p) => p.key === pinnedCallPeer) || remoteTilesData[0] || null;
    const splitPair = primaryRemote ? [primaryRemote, localTileData] : [localTileData];

    grid.style.gridTemplateColumns = splitPair.length === 1 ? '1fr' : '';
    for (const item of splitPair) {
      grid.appendChild(
        buildMediaTile(item, () => {
          pinnedCallPeer = item.key;
          setCallLayout('spotlight');
        })
      );
    }

    // Any extra group participants appear in a tappable strip to swap into the 50% slot
    const extras = remoteTilesData.filter((p) => !primaryRemote || p.key !== primaryRemote.key);
    if (extras.length > 0) {
      stripSlot.classList.remove('hidden');
      for (const item of extras) {
        stripSlot.appendChild(
          buildMediaTile(item, () => {
            pinnedCallPeer = item.key;
            renderCallUI(callManager?.getActiveCallInfo() || null);
          })
        );
      }
    }
    return;
  }

  if (callLayout === 'spotlight') {
    // Fullscreen speaker + floating bottom-right PiP (Messenger/WhatsApp style)
    let mainTile;
    let pipTile = null;
    let stripTiles = [];

    if (remoteTilesData.length === 0) {
      mainTile = localTileData;
    } else if (pinnedCallPeer === 'local') {
      mainTile = localTileData;
      pipTile = remoteTilesData[0];
      stripTiles = remoteTilesData.slice(1);
    } else {
      mainTile = remoteTilesData.find((p) => p.key === pinnedCallPeer) || remoteTilesData[0];
      pipTile = localTileData;
      stripTiles = remoteTilesData.filter((p) => p.key !== mainTile.key);
    }

    grid.appendChild(
      buildMediaTile(mainTile, () => {
        // Clicking main spotlight toggles to equal grid when >1 participant
        if (allTiles.length > 1) setCallLayout('grid');
      })
    );

    if (pipTile) {
      pipSlot.classList.remove('hidden');
      pipSlot.appendChild(
        buildMediaTile(pipTile, () => {
          // Clicking PiP swaps who is fullscreen (classic Messenger/WhatsApp gesture!)
          pinnedCallPeer = pipTile.key;
          renderCallUI(callManager?.getActiveCallInfo() || null);
        })
      );
    }

    if (stripTiles.length > 0) {
      stripSlot.classList.remove('hidden');
      for (const item of stripTiles) {
        stripSlot.appendChild(
          buildMediaTile(item, () => {
            pinnedCallPeer = item.key;
            renderCallUI(callManager?.getActiveCallInfo() || null);
          })
        );
      }
    }
  }
}

function buildMediaTile({ name, pubkey, stream, muted, isLocal, audioMuted, hasVideo }, onClick) {
  const tile = document.createElement('div');
  tile.className = 'media-tile' + (isLocal ? ' is-local' : '');
  tile.title = t('callTapToFocus');
  if (onClick) tile.addEventListener('click', onClick);

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

  if (audioMuted) {
    const badge = document.createElement('span');
    badge.className = 'media-tile-badge';
    badge.textContent = '🔇';
    tile.appendChild(badge);
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
    callLayout = withVideo ? 'spotlight' : 'compact';
    pinnedCallPeer = null;
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

// --- Messenger-style Full Emoji & GIF Picker ---

function setupEmojiPopover() {
  renderEmojiCategoryBar();
  renderEmojiGrid();
}

function openPicker({ tab = 'emoji', reactTargetMsgId = null } = {}) {
  pickerReactTargetMsgId = reactTargetMsgId;
  // Hide GIF tab when choosing an emoji reaction for a message
  $('pickerTabGif').classList.toggle('hidden', Boolean(reactTargetMsgId));
  setPickerTab(reactTargetMsgId ? 'emoji' : tab);
  $('emojiPopover').classList.remove('hidden');
  if (pickerTab === 'emoji') {
    $('emojiSearchInput').value = '';
    renderEmojiCategoryBar();
    renderEmojiGrid();
    if (window.innerWidth > 768) $('emojiSearchInput').focus();
  } else {
    loadGiphyGifs($('gifSearchInput').value);
    if (window.innerWidth > 768) $('gifSearchInput').focus();
  }
}

function closePicker() {
  $('emojiPopover').classList.add('hidden');
  pickerReactTargetMsgId = null;
}

function setPickerTab(tab) {
  pickerTab = tab === 'gif' ? 'gif' : 'emoji';
  $('pickerTabEmoji').classList.toggle('active', pickerTab === 'emoji');
  $('pickerTabGif').classList.toggle('active', pickerTab === 'gif');
  $('pickerEmojiPane').classList.toggle('hidden', pickerTab !== 'emoji');
  $('pickerGifPane').classList.toggle('hidden', pickerTab !== 'gif');
  if (pickerTab === 'gif') {
    loadGiphyGifs($('gifSearchInput').value);
  }
}

function renderEmojiCategoryBar() {
  const bar = $('emojiCatBar');
  bar.textContent = '';
  for (const cat of EMOJI_CATEGORIES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'emoji-cat-btn' + (cat.id === activeEmojiCat ? ' active' : '');
    btn.textContent = cat.icon;
    btn.title = settings.lang === 'et' ? cat.labelEt : cat.labelEn;
    btn.addEventListener('click', () => {
      activeEmojiCat = cat.id;
      $('emojiSearchInput').value = '';
      renderEmojiCategoryBar();
      renderEmojiGrid();
    });
    bar.appendChild(btn);
  }
}

function renderEmojiGrid() {
  const grid = $('emojiGrid');
  grid.textContent = '';
  const query = $('emojiSearchInput').value.trim();

  let emojis = [];
  if (query) {
    emojis = searchEmojis(query);
  } else if (activeEmojiCat === 'recent') {
    emojis = settings.recentEmojis || [];
  } else {
    const cat = EMOJI_CATEGORIES.find((c) => c.id === activeEmojiCat) || EMOJI_CATEGORIES[1];
    emojis = cat.items.map(([em]) => em);
  }

  if (emojis.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'picker-empty';
    empty.textContent = query ? t('emojiNoneFound') : t('emojiRecentEmpty');
    grid.appendChild(empty);
    return;
  }

  for (const em of emojis) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'emoji-btn';
    b.textContent = em;
    b.addEventListener('click', () => handleEmojiSelected(em));
    grid.appendChild(b);
  }
}

function rememberRecentEmoji(em) {
  const next = [em, ...(settings.recentEmojis || []).filter((x) => x !== em)].slice(0, 32);
  settings.recentEmojis = next;
  saveSettings(settings);
}

function handleEmojiSelected(em) {
  rememberRecentEmoji(em);
  if (pickerReactTargetMsgId) {
    const targetId = pickerReactTargetMsgId;
    closePicker();
    toggleReaction(targetId, em);
    return;
  }
  const inp = $('messageInput');
  const start = inp.selectionStart ?? inp.value.length;
  const end = inp.selectionEnd ?? inp.value.length;
  inp.value = inp.value.slice(0, start) + em + inp.value.slice(end);
  const nextPos = start + em.length;
  inp.setSelectionRange(nextPos, nextPos);
  inp.focus();
}

async function loadGiphyGifs(query = '') {
  const grid = $('gifResults');
  const apiKey = (settings.giphyApiKey || CONFIG.GIPHY_API_KEY || '').trim();
  $('gifSearchWrap').classList.toggle('hidden', !apiKey);

  if (!apiKey) {
    grid.textContent = '';
    const note = document.createElement('div');
    note.className = 'picker-empty';
    note.textContent = t('gifNoKeyHint');
    grid.appendChild(note);
    return;
  }

  grid.textContent = '';
  const loading = document.createElement('div');
  loading.className = 'picker-empty';
  loading.textContent = t('gifLoading');
  grid.appendChild(loading);

  try {
    const q = query.trim();
    const endpoint = q
      ? `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(q)}&limit=24&rating=g`
      : `https://api.giphy.com/v1/gifs/trending?api_key=${encodeURIComponent(apiKey)}&limit=24&rating=g`;
    const res = await fetch(endpoint);
    if (!res.ok) throw new Error('GIPHY HTTP ' + res.status);
    const json = await res.json();
    const items = Array.isArray(json.data) ? json.data : [];

    grid.textContent = '';
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'picker-empty';
      empty.textContent = t('emojiNoneFound');
      grid.appendChild(empty);
      return;
    }

    for (const g of items) {
      const thumbUrl = g.images?.fixed_width_small?.url || g.images?.fixed_width?.url;
      const sendUrl = g.images?.downsized_medium?.url || g.images?.fixed_width?.url || thumbUrl;
      if (!isSafeHttpsUrl(thumbUrl) || !isSafeHttpsUrl(sendUrl)) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gif-thumb-btn';
      btn.title = g.title || 'GIF';
      const img = document.createElement('img');
      img.src = thumbUrl;
      img.alt = g.title || 'GIF';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      btn.appendChild(img);
      btn.addEventListener('click', async () => {
        closePicker();
        await sendTextMessage('', { url: sendUrl, title: g.title || 'GIF' });
      });
      grid.appendChild(btn);
    }
  } catch {
    grid.textContent = '';
    const err = document.createElement('div');
    err.className = 'picker-empty';
    err.textContent = t('gifError');
    grid.appendChild(err);
  }
}

function openSeenModal(viewers) {
  const list = $('seenList');
  list.textContent = '';
  for (const v of viewers) {
    const item = document.createElement('div');
    item.className = 'online-row';
    const av = document.createElement('div');
    av.className = 'online-avatar';
    av.style.background = colorFromPubkey(v.pubkey);
    av.textContent = (v.name[0] || '?').toUpperCase();
    const info = document.createElement('div');
    const nm = document.createElement('div');
    nm.textContent = v.name;
    const tm = document.createElement('div');
    tm.className = 'muted small';
    tm.textContent = `${formatSeenTime(v.seenAtMs)} · ${shortFingerprint(v.pubkey)}`;
    info.append(nm, tm);
    item.append(av, info);
    list.appendChild(item);
  }
  showOverlay('seenModal');
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

  const customRelays = arraysEqual(settings.relays, getDefaultRelays()) ? null : settings.relays;
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

function renderIdentityStatusPill() {
  const el = $('settingsIdentityStatus');
  if (!el) return;
  const base = settings.hasPasswordIdentity ? t('identityStatusPassword') : t('identityStatusDevice');
  const lock = settings.deviceLockEnabled ? ` · 🔒 ${t('identityStatusLocked')}` : '';
  el.textContent = base + lock;
}

async function rehydrateAllRoomIdentities() {
  for (const state of roomsState.values()) {
    state.identity = await deriveRoomIdentity(activeMasterSeed, state.room.channelId);
  }
  if (activeChannelId) {
    announcePresence(activeChannelId, 'online');
    renderMessages(false);
    renderOnlineCount();
  }
  renderRoomList();
}

function openSettingsModal() {
  $('settingsNameInput').value = settings.name;
  $('settingsIdentityPassInput').value = '';
  $('settingsDeviceLockCheck').checked = settings.deviceLockEnabled;
  renderIdentityStatusPill();
  $('settingsThemeSelect').value = settings.theme;
  $('settingsLangSelect').value = settings.lang;
  $('settingsSoundCheck').checked = settings.sound;
  $('settingsNotifyCheck').checked = settings.notifications;
  $('settingsReadReceiptsCheck').checked = settings.readReceipts;
  $('settingsGiphyKeyInput').value = settings.giphyApiKey || '';
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
    if (ov.id === 'welcomeOverlay' || ov.id === 'gateOverlay' || ov.id === 'unlockOverlay') return;
    ov.addEventListener('click', (e) => {
      if (e.target === ov) hideOverlay(ov.id);
    });
  });

  // Unlock local device vault
  $('unlockForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pass = $('unlockPassInput').value;
    if (!pass) return;
    const btn = $('unlockSubmitBtn');
    btn.disabled = true;
    btn.textContent = t('derivingKeys');
    try {
      const decrypted = await decryptLocalVault(pass, settings.lockedVault);
      if (!decrypted || typeof decrypted.masterSeed !== 'string' || decrypted.masterSeed.length !== 64) {
        $('unlockError').textContent = t('unlockWrong');
        $('unlockError').classList.remove('hidden');
        return;
      }
      activeMasterSeed = decrypted.masterSeed;
      hideOverlay('unlockOverlay');
      await startApp();
    } finally {
      btn.disabled = false;
      btn.textContent = t('unlockBtn');
    }
  });

  $('unlockResetBtn').addEventListener('click', async () => {
    if (!confirm(t('clearAllConfirm'))) return;
    await clearAllData();
    window.location.reload();
  });

  $('lockAppBtn').addEventListener('click', () => {
    if (callManager) callManager.leaveCall();
    if (activeChannelId) announcePresence(activeChannelId, 'leave');
    window.location.reload();
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

  // Welcome form (with optional personal password & device lock)
  $('welcomeLangBtn').addEventListener('click', () => {
    settings.lang = settings.lang === 'et' ? 'en' : 'et';
    saveSettings(settings);
    applyI18n();
    openWelcomeOverlay();
  });

  $('welcomePassInput').addEventListener('input', () => {
    const hasPass = $('welcomePassInput').value.length > 0;
    $('welcomeLockRow').classList.toggle('hidden', !hasPass);
    if (!hasPass) $('welcomeLockCheck').checked = false;
  });

  $('welcomeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('welcomeNameInput').value.trim();
    if (!name) {
      $('welcomeError').textContent = t('errEnterName');
      $('welcomeError').classList.remove('hidden');
      return;
    }
    const userPass = $('welcomePassInput').value;
    const lockDevice = userPass.length > 0 && $('welcomeLockCheck').checked;
    const btn = $('welcomeSubmitBtn');
    btn.disabled = true;
    btn.textContent = t('derivingKeys');

    try {
      settings.name = name.slice(0, 32);
      if (userPass.length > 0) {
        activeMasterSeed = await deriveMasterSeedFromPassword(settings.name, userPass);
        settings.hasPasswordIdentity = true;
        if (lockDevice) {
          settings.deviceLockEnabled = true;
          settings.lockedVault = await encryptLocalVault(userPass, { masterSeed: activeMasterSeed });
          settings.masterSeed = null;
        } else {
          settings.deviceLockEnabled = false;
          settings.lockedVault = null;
          settings.masterSeed = activeMasterSeed;
        }
      } else {
        activeMasterSeed = settings.masterSeed || generateMasterSeed();
        settings.masterSeed = activeMasterSeed;
        settings.hasPasswordIdentity = false;
        settings.deviceLockEnabled = false;
        settings.lockedVault = null;
      }
      saveSettings(settings);
      hideOverlay('welcomeOverlay');
      await startApp();
    } finally {
      btn.disabled = false;
      btn.textContent = pendingInvite ? t('joinInvitedBtn') : t('startBtn');
    }
  });

  // Update / set personal password from Settings
  $('applyIdentityBtn').addEventListener('click', async () => {
    const name = $('settingsNameInput').value.trim() || settings.name;
    const userPass = $('settingsIdentityPassInput').value;
    const wantLock = $('settingsDeviceLockCheck').checked;

    if (!userPass && wantLock && !settings.deviceLockEnabled) {
      showToast(t('identityPassNeeded'));
      return;
    }

    const btn = $('applyIdentityBtn');
    btn.disabled = true;
    btn.textContent = t('derivingKeys');
    try {
      settings.name = name.slice(0, 32);
      if (userPass.length > 0) {
        activeMasterSeed = await deriveMasterSeedFromPassword(settings.name, userPass);
        settings.hasPasswordIdentity = true;
        if (wantLock) {
          settings.deviceLockEnabled = true;
          settings.lockedVault = await encryptLocalVault(userPass, { masterSeed: activeMasterSeed });
          settings.masterSeed = null;
        } else {
          settings.deviceLockEnabled = false;
          settings.lockedVault = null;
          settings.masterSeed = activeMasterSeed;
        }
        await rehydrateAllRoomIdentities();
      } else if (!wantLock && settings.deviceLockEnabled) {
        // User turned off local device lock while keeping current unlocked identity
        settings.deviceLockEnabled = false;
        settings.lockedVault = null;
        settings.masterSeed = activeMasterSeed;
      }
      saveSettings(settings);
      $('settingsIdentityPassInput').value = '';
      $('sidebarUserName').textContent = settings.name;
      $('lockAppBtn').classList.toggle('hidden', !settings.deviceLockEnabled);
      renderIdentityStatusPill();
      showToast(t('identityUpdatedToast'));
    } finally {
      btn.disabled = false;
      btn.textContent = t('identityUpdateBtn');
    }
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
  $('joinCallVideoBtn').addEventListener('click', () => startRoomCall(true));
  $('layoutCompactBtn').addEventListener('click', () => setCallLayout('compact'));
  $('layoutGridBtn').addEventListener('click', () => setCallLayout('grid'));
  $('layoutSplitBtn').addEventListener('click', () => setCallLayout('split'));
  $('layoutSpotlightBtn').addEventListener('click', () => setCallLayout('spotlight'));
  $('callBackToChatBtn').addEventListener('click', () => setCallLayout('compact'));
  $('callFullscreenBtn').addEventListener('click', async () => {
    const panel = $('callPanel');
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        if (callLayout === 'compact') setCallLayout('spotlight');
        if (panel.requestFullscreen) await panel.requestFullscreen();
      }
    } catch {
      // Browser may block fullscreen on some mobile Safari builds — CSS fullscreen overlay still works!
    }
  });
  $('toggleMuteBtn').addEventListener('click', () => callManager?.toggleMute());
  $('toggleCamBtn').addEventListener('click', async () => {
    try {
      await callManager?.toggleVideo();
    } catch {
      showToast(t('callMediaError'), 5000);
    }
  });
  $('hangupBtn').addEventListener('click', () => callManager?.leaveCall());

  function getOwnMessageIdsInRoom(state) {
    const ids = [];
    for (const m of state.messages.values()) {
      if (m.pubkey === state.identity.pubkeyHex) ids.push(m.id);
    }
    return ids;
  }

  async function leaveActiveRoomLocally() {
    const state = roomsState.get(activeChannelId);
    if (!state) return;
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
  }

  $('leaveRoomBtn').addEventListener('click', () => {
    const state = roomsState.get(activeChannelId);
    if (!state) return;
    const ownCount = getOwnMessageIdsInRoom(state).length;
    $('leaveRoomDesc').textContent = t('leaveModalDesc', state.room.name, ownCount);
    $('purgeOwnStayBtn').disabled = ownCount === 0;
    $('purgeOwnAndLeaveBtn').disabled = ownCount === 0;
    showOverlay('leaveRoomModal');
  });

  $('leaveLocalOnlyBtn').addEventListener('click', async () => {
    hideOverlay('leaveRoomModal');
    await leaveActiveRoomLocally();
  });

  $('purgeOwnStayBtn').addEventListener('click', async () => {
    const state = roomsState.get(activeChannelId);
    if (!state) return;
    const ownIds = getOwnMessageIdsInRoom(state);
    hideOverlay('leaveRoomModal');
    if (ownIds.length === 0) {
      showToast(t('noOwnMsgsToast'));
      return;
    }
    const deleted = await deleteOwnMessages(state.room.channelId, ownIds);
    showToast(t('myMsgsDeletedToast', deleted));
  });

  $('purgeOwnAndLeaveBtn').addEventListener('click', async () => {
    const state = roomsState.get(activeChannelId);
    if (!state) return;
    const ownIds = getOwnMessageIdsInRoom(state);
    hideOverlay('leaveRoomModal');
    const deleted = await deleteOwnMessages(state.room.channelId, ownIds);
    if (deleted > 0) showToast(t('myMsgsDeletedToast', deleted));
    await leaveActiveRoomLocally();
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
    const pop = $('emojiPopover');
    if (pop.classList.contains('hidden') || pickerReactTargetMsgId) {
      openPicker({ tab: pickerTab, reactTargetMsgId: null });
    } else {
      closePicker();
    }
  });
  $('pickerTabEmoji').addEventListener('click', () => setPickerTab('emoji'));
  $('pickerTabGif').addEventListener('click', () => setPickerTab('gif'));
  $('emojiSearchInput').addEventListener('input', () => renderEmojiGrid());
  $('gifSearchInput').addEventListener('input', () => {
    clearTimeout(gifSearchTimer);
    gifSearchTimer = setTimeout(() => loadGiphyGifs($('gifSearchInput').value), 350);
  });
  $('gifSendUrlBtn').addEventListener('click', async () => {
    const url = $('gifUrlInput').value.trim();
    if (!isSafeHttpsUrl(url)) {
      showToast(t('gifInvalidUrl'));
      return;
    }
    $('gifUrlInput').value = '';
    closePicker();
    await sendTextMessage('', { url, title: 'GIF' });
  });
  $('gifUrlInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('gifSendUrlBtn').click();
    }
  });

  document.addEventListener('click', (e) => {
    const pop = $('emojiPopover');
    if (!pop.classList.contains('hidden') && !pop.contains(e.target) && e.target !== $('emojiPickerBtn')) {
      closePicker();
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
    $('settingsRelaysInput').value = getDefaultRelays().join('\n');
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
    settings.readReceipts = $('settingsReadReceiptsCheck').checked;
    settings.giphyApiKey = $('settingsGiphyKeyInput').value.trim();

    const relays = $('settingsRelaysInput')
      .value.split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('wss://') || l.startsWith('ws://'));
    if (relays.length > 0) {
      settings.relays = [...new Set(relays)];
      settings.customRelays = !arraysEqual(settings.relays, getDefaultRelays());
    }

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
    const data = await exportBackup(settings, activeMasterSeed);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `decloc-backup-${new Date().toISOString().slice(0, 10)}.json`;
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
      if (data?.format !== 'decloc-backup-v1' || !data.profile?.masterSeed) {
        throw new Error('Bad format');
      }
      settings.name = String(data.profile.name || settings.name || 'User').slice(0, 32);
      activeMasterSeed = data.profile.masterSeed;
      settings.masterSeed = activeMasterSeed;
      settings.hasPasswordIdentity = data.profile.hasPasswordIdentity === true;
      settings.deviceLockEnabled = false;
      settings.lockedVault = null;
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
        scheduleReadReceipt(state);
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

function formatSeenTime(ms) {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return formatClock(ms);
  return `${d.toLocaleDateString(settings.lang === 'et' ? 'et-EE' : 'en-GB', {
    day: 'numeric',
    month: 'short',
  })} ${formatClock(ms)}`;
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
