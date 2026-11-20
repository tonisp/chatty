// Pure-JS cryptography for Kaja Chat:
// - BIP-340 secp256k1 Schnorr signatures (Nostr NIP-01)
// - Web Crypto PBKDF2-SHA256, HMAC-SHA256, AES-256-GCM (Room E2EE)
// Zero external dependencies — works offline and directly on GitHub Pages.

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = {
  X: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  Y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
  Z: 1n,
};
const INF = { X: 0n, Y: 1n, Z: 0n };
const SQRT_EXP = (P + 1n) >> 2n;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function hasWebCrypto() {
  return Boolean(globalThis.crypto && globalThis.crypto.subtle);
}

export function utf8ToBytes(str) {
  return enc.encode(str);
}

export function bytesToUtf8(bytes) {
  return dec.decode(bytes);
}

export function bytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('Invalid hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function concatBytes(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

export function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function base64UrlEncode(str) {
  return bytesToBase64(utf8ToBytes(str))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function base64UrlDecode(b64url) {
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return bytesToUtf8(base64ToBytes(b64));
}

export function randomBytes(len) {
  const buf = new Uint8Array(len);
  globalThis.crypto.getRandomValues(buf);
  return buf;
}

export async function sha256(bytes) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(buf);
}

export async function sha256Hex(strOrBytes) {
  const input = typeof strOrBytes === 'string' ? utf8ToBytes(strOrBytes) : strOrBytes;
  return bytesToHex(await sha256(input));
}

export async function hmacSha256(keyBytes, msgBytes) {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, msgBytes);
  return new Uint8Array(sig);
}

// --- BigInt modular & secp256k1 Jacobian elliptic curve arithmetic ---

function mod(a, m = P) {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

function modPow(base, exp, m = P) {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

function bytesToBigInt(bytes) {
  return BigInt('0x' + (bytesToHex(bytes) || '0'));
}

function bigIntToBytes32(num) {
  const hex = num.toString(16).padStart(64, '0');
  return hexToBytes(hex);
}

function pointDouble(p) {
  if (p.Z === 0n || p.Y === 0n) return INF;
  const { X: X1, Y: Y1, Z: Z1 } = p;
  const A = mod(X1 * X1);
  const B = mod(Y1 * Y1);
  const C = mod(B * B);
  const D = mod(2n * (mod((X1 + B) * (X1 + B)) - A - C));
  const E = mod(3n * A);
  const F = mod(E * E);
  const X3 = mod(F - 2n * D);
  const Y3 = mod(E * (D - X3) - 8n * C);
  const Z3 = mod(2n * Y1 * Z1);
  return { X: X3, Y: Y3, Z: Z3 };
}

function pointAdd(p1, p2) {
  if (p1.Z === 0n) return p2;
  if (p2.Z === 0n) return p1;
  const Z1Z1 = mod(p1.Z * p1.Z);
  const Z2Z2 = mod(p2.Z * p2.Z);
  const U1 = mod(p1.X * Z2Z2);
  const U2 = mod(p2.X * Z1Z1);
  const S1 = mod(p1.Y * p2.Z * Z2Z2);
  const S2 = mod(p2.Y * p1.Z * Z1Z1);
  if (U1 === U2) {
    return S1 === S2 ? pointDouble(p1) : INF;
  }
  const H = mod(U2 - U1);
  const R = mod(S2 - S1);
  const H2 = mod(H * H);
  const H3 = mod(H * H2);
  const U1H2 = mod(U1 * H2);
  const X3 = mod(R * R - H3 - 2n * U1H2);
  const Y3 = mod(R * (U1H2 - X3) - S1 * H3);
  const Z3 = mod(H * p1.Z * p2.Z);
  return { X: X3, Y: Y3, Z: Z3 };
}

function pointMul(p, scalar) {
  let k = mod(scalar, N);
  if (k === 0n) return INF;
  let result = INF;
  let addend = p;
  while (k > 0n) {
    if (k & 1n) result = pointAdd(result, addend);
    addend = pointDouble(addend);
    k >>= 1n;
  }
  return result;
}

function toAffine(p) {
  if (p.Z === 0n) return null;
  const zInv = modPow(p.Z, P - 2n, P);
  const zInv2 = mod(zInv * zInv);
  const zInv3 = mod(zInv2 * zInv);
  return {
    x: mod(p.X * zInv2),
    y: mod(p.Y * zInv3),
  };
}

function hasEvenY(pt) {
  return (pt.y & 1n) === 0n;
}

function liftX(x) {
  if (x < 0n || x >= P) return null;
  const c = mod(modPow(x, 3n, P) + 7n, P);
  let y = modPow(c, SQRT_EXP, P);
  if (mod(y * y, P) !== c) return null;
  if ((y & 1n) !== 0n) y = P - y;
  return { x, y };
}

// --- BIP-340 Tagged Hashes & Schnorr Signatures ---

const tagHashCache = new Map();

async function taggedHash(tag, msgBytes) {
  let th = tagHashCache.get(tag);
  if (!th) {
    th = await sha256(utf8ToBytes(tag));
    tagHashCache.set(tag, th);
  }
  return sha256(concatBytes(th, th, msgBytes));
}

export function getPublicKeyBytes(privKeyBytes) {
  const d = bytesToBigInt(privKeyBytes);
  if (d <= 0n || d >= N) throw new Error('Invalid private key');
  const pt = toAffine(pointMul(G, d));
  return bigIntToBytes32(pt.x);
}

export function getPublicKeyHex(privKeyBytes) {
  return bytesToHex(getPublicKeyBytes(privKeyBytes));
}

export async function schnorrSign(msg32, privKey32, auxRand32 = randomBytes(32)) {
  if (msg32.length !== 32 || privKey32.length !== 32 || auxRand32.length !== 32) {
    throw new Error('BIP-340 expects 32-byte inputs');
  }
  const dPrime = bytesToBigInt(privKey32);
  if (dPrime <= 0n || dPrime >= N) throw new Error('Invalid private key');

  const pt = toAffine(pointMul(G, dPrime));
  const d = hasEvenY(pt) ? dPrime : N - dPrime;
  const dBytes = bigIntToBytes32(d);
  const pxBytes = bigIntToBytes32(pt.x);

  const auxHash = await taggedHash('BIP0340/aux', auxRand32);
  const t = new Uint8Array(32);
  for (let i = 0; i < 32; i++) t[i] = dBytes[i] ^ auxHash[i];

  const rand = await taggedHash('BIP0340/nonce', concatBytes(t, pxBytes, msg32));
  const kPrime = mod(bytesToBigInt(rand), N);
  if (kPrime === 0n) throw new Error('Zero nonce generated');

  const R = toAffine(pointMul(G, kPrime));
  const k = hasEvenY(R) ? kPrime : N - kPrime;
  const rxBytes = bigIntToBytes32(R.x);

  const eBytes = await taggedHash('BIP0340/challenge', concatBytes(rxBytes, pxBytes, msg32));
  const e = mod(bytesToBigInt(eBytes), N);
  const s = mod(k + e * d, N);

  return concatBytes(rxBytes, bigIntToBytes32(s));
}

export async function schnorrVerify(msg32, pubKey32, sig64) {
  if (msg32.length !== 32 || pubKey32.length !== 32 || sig64.length !== 64) {
    return false;
  }
  const px = bytesToBigInt(pubKey32);
  const pt = liftX(px);
  if (!pt) return false;

  const rBytes = sig64.subarray(0, 32);
  const sBytes = sig64.subarray(32, 64);
  const r = bytesToBigInt(rBytes);
  const s = bytesToBigInt(sBytes);
  if (r >= P || s >= N) return false;

  const eBytes = await taggedHash('BIP0340/challenge', concatBytes(rBytes, pubKey32, msg32));
  const e = mod(bytesToBigInt(eBytes), N);

  const sG = pointMul(G, s);
  const negEP = pointMul({ X: pt.x, Y: pt.y, Z: 1n }, mod(N - e, N));
  const R = toAffine(pointAdd(sG, negEP));

  if (!R || !hasEvenY(R) || R.x !== r) return false;
  return true;
}

// --- Nostr NIP-01 Event Signing & Verification ---

export async function getEventIdBytes(ev) {
  const serialized = JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
  return sha256(utf8ToBytes(serialized));
}

export async function signNostrEvent(unsignedEv, privKeyBytes) {
  const pubkey = getPublicKeyHex(privKeyBytes);
  const ev = {
    pubkey,
    created_at: unsignedEv.created_at ?? Math.floor(Date.now() / 1000),
    kind: unsignedEv.kind,
    tags: unsignedEv.tags ?? [],
    content: unsignedEv.content ?? '',
  };
  const idBytes = await getEventIdBytes(ev);
  const sigBytes = await schnorrSign(idBytes, privKeyBytes);
  return {
    ...ev,
    id: bytesToHex(idBytes),
    sig: bytesToHex(sigBytes),
  };
}

export async function verifyNostrEvent(ev) {
  try {
    if (
      !ev ||
      typeof ev.id !== 'string' ||
      typeof ev.pubkey !== 'string' ||
      typeof ev.sig !== 'string' ||
      typeof ev.created_at !== 'number' ||
      typeof ev.kind !== 'number' ||
      !Array.isArray(ev.tags) ||
      typeof ev.content !== 'string'
    ) {
      return false;
    }
    if (ev.id.length !== 64 || ev.pubkey.length !== 64 || ev.sig.length !== 128) {
      return false;
    }
    const idBytes = await getEventIdBytes(ev);
    if (bytesToHex(idBytes) !== ev.id.toLowerCase()) return false;
    return await schnorrVerify(idBytes, hexToBytes(ev.pubkey), hexToBytes(ev.sig));
  } catch {
    return false;
  }
}

// --- Room E2EE Key Derivation & Payload Encryption ---

export function normalizeRoomSlug(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export async function deriveRoomSecrets(roomName, passphrase) {
  const slug = normalizeRoomSlug(roomName);
  if (!slug || !passphrase) throw new Error('Room name and passphrase are required');

  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    utf8ToBytes(passphrase),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const masterBuf = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: utf8ToBytes('kaja-chat:v1:room:' + slug),
      iterations: 200000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  const masterBits = new Uint8Array(masterBuf);

  // Domain-separated keys: channelId (public relay tag) cannot reveal aesKey (secret)
  const channelIdBytes = await hmacSha256(masterBits, utf8ToBytes('channel-id'));
  const aesKeyBytes = await hmacSha256(masterBits, utf8ToBytes('aes-gcm-key'));

  const aesKey = await globalThis.crypto.subtle.importKey(
    'raw',
    aesKeyBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );

  return {
    slug,
    channelId: bytesToHex(channelIdBytes),
    aesKey,
  };
}

// Derive a unique secp256k1 identity per room from user's master seed
// so public relays cannot correlate a user across different rooms.
export async function deriveRoomIdentity(masterSeedHex, channelId) {
  const raw = await hmacSha256(
    hexToBytes(masterSeedHex),
    utf8ToBytes('kaja-chat:v1:identity:' + channelId)
  );
  const d = (bytesToBigInt(raw) % (N - 1n)) + 1n;
  const privKeyBytes = bigIntToBytes32(d);
  const pubkeyHex = getPublicKeyHex(privKeyBytes);
  return { privKeyBytes, pubkeyHex };
}

export async function encryptRoomPayload(aesKey, pubkeyHex, channelId, payloadObj) {
  const iv = randomBytes(12);
  const plaintext = utf8ToBytes(JSON.stringify(payloadObj));
  const aad = utf8ToBytes(`${pubkeyHex}:${channelId}`);
  const ctBuf = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    aesKey,
    plaintext
  );
  return 'v1:' + bytesToBase64(concatBytes(iv, new Uint8Array(ctBuf)));
}

export async function decryptRoomPayload(aesKey, pubkeyHex, channelId, content) {
  if (typeof content !== 'string' || !content.startsWith('v1:')) return null;
  try {
    const raw = base64ToBytes(content.slice(3));
    if (raw.length < 28) return null; // 12-byte IV + 16-byte GCM tag minimum
    const iv = raw.subarray(0, 12);
    const ct = raw.subarray(12);
    const aad = utf8ToBytes(`${pubkeyHex}:${channelId}`);
    const ptBuf = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad },
      aesKey,
      ct
    );
    return JSON.parse(bytesToUtf8(new Uint8Array(ptBuf)));
  } catch {
    return null;
  }
}

// --- User-Friendly Helpers ---

const PASSPHRASE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function generatePassphrase(groups = 4, groupLen = 4) {
  const total = groups * groupLen;
  const bytes = randomBytes(total * 2);
  const chars = [];
  let idx = 0;
  // Rejection sampling for uniform randomness
  const limit = 256 - (256 % PASSPHRASE_ALPHABET.length);
  while (chars.length < total) {
    const b = idx < bytes.length ? bytes[idx++] : randomBytes(1)[0];
    if (b < limit) {
      chars.push(PASSPHRASE_ALPHABET[b % PASSPHRASE_ALPHABET.length]);
    }
  }
  const parts = [];
  for (let i = 0; i < groups; i++) {
    parts.push(chars.slice(i * groupLen, (i + 1) * groupLen).join(''));
  }
  return parts.join('-');
}

export function generateMasterSeed() {
  return bytesToHex(randomBytes(32));
}

export function encodeInviteUrl(baseUrl, { name, passphrase, relays }) {
  const payload = { n: name, p: passphrase };
  if (Array.isArray(relays) && relays.length > 0) {
    payload.r = relays;
  }
  const cleanBase = baseUrl.split('#')[0].split('?')[0];
  return `${cleanBase}#join=${base64UrlEncode(JSON.stringify(payload))}`;
}

export function decodeInviteHash(hashStr) {
  if (!hashStr || !hashStr.includes('join=')) return null;
  try {
    const raw = hashStr.replace(/^#/, '');
    const params = new URLSearchParams(raw);
    const token = params.get('join');
    if (!token) return null;
    const data = JSON.parse(base64UrlDecode(token));
    if (typeof data?.n !== 'string' || typeof data?.p !== 'string') return null;
    return {
      name: data.n.trim(),
      passphrase: data.p,
      relays: Array.isArray(data.r) ? data.r.filter((x) => typeof x === 'string' && x.startsWith('wss://')) : null,
    };
  } catch {
    return null;
  }
}

export function shortFingerprint(pubkeyHex) {
  return '#' + String(pubkeyHex || '0000').slice(0, 4);
}

export function colorFromPubkey(pubkeyHex) {
  const hash = parseInt(String(pubkeyHex || '000000').slice(0, 6), 16) || 0;
  const hue = hash % 360;
  return `hsl(${hue}, 72%, 58%)`;
}
