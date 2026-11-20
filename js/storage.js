import { CONFIG } from '../config.js';
import { generateMasterSeed } from './crypto.js';

const SETTINGS_KEY = 'kaja_settings_v1';
const DB_NAME = 'kaja_chat_db_v1';
const DB_VERSION = 1;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('rooms')) {
        db.createObjectStore('rooms', { keyPath: 'channelId' });
      }
      if (!db.objectStoreNames.contains('messages')) {
        const msgStore = db.createObjectStore('messages', { keyPath: 'id' });
        msgStore.createIndex('by_room_time', ['channelId', 'createdAt'], { unique: false });
        msgStore.createIndex('by_room', 'channelId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// --- Settings & Profile (localStorage) ---

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      name: typeof parsed.name === 'string' ? parsed.name : '',
      masterSeed: typeof parsed.masterSeed === 'string' && parsed.masterSeed.length === 64
        ? parsed.masterSeed
        : generateMasterSeed(),
      lang: parsed.lang === 'en' || parsed.lang === 'et' ? parsed.lang : CONFIG.DEFAULT_LANG,
      theme: ['system', 'dark', 'light'].includes(parsed.theme) ? parsed.theme : 'system',
      sound: parsed.sound !== false,
      notifications: parsed.notifications === true,
      relays: Array.isArray(parsed.relays) && parsed.relays.length > 0
        ? parsed.relays.filter((r) => typeof r === 'string' && r.startsWith('wss://'))
        : [...CONFIG.DEFAULT_RELAYS],
      gatePassed: parsed.gatePassed === true,
      lastRoomId: typeof parsed.lastRoomId === 'string' ? parsed.lastRoomId : null,
    };
  } catch {
    return {
      name: '',
      masterSeed: generateMasterSeed(),
      lang: CONFIG.DEFAULT_LANG,
      theme: 'system',
      sound: true,
      notifications: false,
      relays: [...CONFIG.DEFAULT_RELAYS],
      gatePassed: false,
      lastRoomId: null,
    };
  }
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// --- Rooms (IndexedDB) ---

export async function getAllRooms() {
  const db = await openDB();
  const tx = db.transaction('rooms', 'readonly');
  const rooms = await reqToPromise(tx.objectStore('rooms').getAll());
  return rooms.sort((a, b) => (b.lastActivity || b.joinedAt || 0) - (a.lastActivity || a.joinedAt || 0));
}

export async function saveRoom(room) {
  const db = await openDB();
  const tx = db.transaction('rooms', 'readwrite');
  await reqToPromise(tx.objectStore('rooms').put(room));
}

export async function deleteRoom(channelId) {
  const db = await openDB();
  const tx = db.transaction(['rooms', 'messages'], 'readwrite');
  tx.objectStore('rooms').delete(channelId);
  const idx = tx.objectStore('messages').index('by_room');
  const cursorReq = idx.openKeyCursor(IDBKeyRange.only(channelId));
  await new Promise((resolve, reject) => {
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        tx.objectStore('messages').delete(cursor.primaryKey);
        cursor.continue();
      } else {
        resolve();
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

// --- Messages (IndexedDB) ---

export async function saveMessage(msg) {
  const db = await openDB();
  const tx = db.transaction('messages', 'readwrite');
  await reqToPromise(tx.objectStore('messages').put(msg));
}

export async function getRoomMessages(channelId) {
  const db = await openDB();
  const tx = db.transaction('messages', 'readonly');
  const idx = tx.objectStore('messages').index('by_room');
  const items = await reqToPromise(idx.getAll(IDBKeyRange.only(channelId)));
  return items.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export async function getLatestTimestampForRoom(channelId) {
  const msgs = await getRoomMessages(channelId);
  if (msgs.length === 0) return 0;
  return msgs[msgs.length - 1].createdAt;
}

// --- Backup & Wipe ---

export async function exportBackup(settings) {
  const rooms = await getAllRooms();
  return {
    format: 'kaja-backup-v1',
    exportedAt: new Date().toISOString(),
    profile: {
      name: settings.name,
      masterSeed: settings.masterSeed,
      relays: settings.relays,
      lang: settings.lang,
      theme: settings.theme,
    },
    rooms: rooms.map((r) => ({
      channelId: r.channelId,
      name: r.name,
      passphrase: r.passphrase,
      joinedAt: r.joinedAt,
      lastReadAt: r.lastReadAt || 0,
    })),
  };
}

export async function clearAllData() {
  localStorage.removeItem(SETTINGS_KEY);
  if (dbPromise) {
    try {
      const db = await dbPromise;
      db.close();
    } catch {
      // ignore
    }
    dbPromise = null;
  }
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}
