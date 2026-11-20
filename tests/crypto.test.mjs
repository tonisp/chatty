import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bytesToHex,
  hexToBytes,
  getPublicKeyHex,
  schnorrSign,
  schnorrVerify,
  signNostrEvent,
  verifyNostrEvent,
  deriveRoomSecrets,
  deriveRoomIdentity,
  encryptRoomPayload,
  decryptRoomPayload,
  generateMasterSeed,
  generatePassphrase,
  encodeInviteUrl,
  decodeInviteHash,
} from '../js/crypto.js';

// Official BIP-340 test vectors (vectors 0..3)
const BIP340_VECTORS = [
  {
    name: 'vector 0',
    seckey: '0000000000000000000000000000000000000000000000000000000000000003',
    pubkey: 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9',
    aux: '0000000000000000000000000000000000000000000000000000000000000000',
    msg: '0000000000000000000000000000000000000000000000000000000000000000',
    sig: 'e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca821525f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0',
  },
  {
    name: 'vector 1',
    seckey: 'b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef',
    pubkey: 'dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659',
    aux: '0000000000000000000000000000000000000000000000000000000000000001',
    msg: '243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89',
    sig: '6896bd60eeae296db48a229ff71dfe071bde413e6d43f917dc8dcf8c78de33418906d11ac976abccb20b091292bff4ea897efcb639ea871cfa95f6de339e4b0a',
  },
  {
    name: 'vector 2',
    seckey: 'c90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b14e5c9',
    pubkey: 'dd308afec5777e13121fa72b9cc1b7cc0139715309b086c960e18fd969774eb8',
    aux: 'c87aa53824b4d7ae2eb035a2b5bbbccc080e76cdc6d1692c4b0b62d798e6d906',
    msg: '7e2d58d8b3bcdf1abadec7829054f90dda9805aab56c77333024b9d0a508b75c',
    sig: '5831aaeed7b44bb74e5eab94ba9d4294c49bcf2a60728d8b4c200f50dd313c1bab745879a5ad954a72c45a91c3a51d3c7adea98d82f8481e0e1e03674a6f3fb7',
  },
  {
    name: 'vector 3 (odd-Y pubkey negation)',
    seckey: '0b432b2677937381aef05bb02a66ecd012773062cf3fa2549e44f58ed2401710',
    pubkey: '25d1dff95105f5253c4022f628a996ad3a0d95fbf21d468a1b33f8c160d8f517',
    aux: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    msg: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    sig: '7eb0509757e246f19449885651611cb965ecc1a187dd51b64fda1edc9637d5ec97582b9cb13db3933705b32ba982af5af25fd78881ebb32771fc5922efc66ea3',
  },
];

for (const v of BIP340_VECTORS) {
  test(`BIP-340 ${v.name}`, async () => {
    const sk = hexToBytes(v.seckey);
    const pkHex = getPublicKeyHex(sk);
    assert.equal(pkHex, v.pubkey);

    const sig = await schnorrSign(hexToBytes(v.msg), sk, hexToBytes(v.aux));
    assert.equal(bytesToHex(sig), v.sig);

    const valid = await schnorrVerify(hexToBytes(v.msg), hexToBytes(v.pubkey), sig);
    assert.equal(valid, true);

    // Tampered message must fail verification
    const badMsg = hexToBytes(v.msg);
    badMsg[0] ^= 0x01;
    assert.equal(await schnorrVerify(badMsg, hexToBytes(v.pubkey), sig), false);
  });
}

test('Nostr event signing, verification, and tamper detection', async () => {
  const seed = generateMasterSeed();
  const room = await deriveRoomSecrets('Pere Jututuba', 'salajane-parool-123');
  const id = await deriveRoomIdentity(seed, room.channelId);

  const payload = { v: 1, t: 'msg', name: 'Mari', text: 'Tere maailm! 🇪🇪', ts: Date.now() };
  const encrypted = await encryptRoomPayload(room.aesKey, id.pubkeyHex, room.channelId, payload);

  const ev = await signNostrEvent(
    {
      kind: 42,
      tags: [['e', room.channelId, '', 'root']],
      content: encrypted,
    },
    id.privKeyBytes
  );

  assert.equal(await verifyNostrEvent(ev), true);

  // Decrypt with matching room secrets
  const decoded = await decryptRoomPayload(room.aesKey, ev.pubkey, room.channelId, ev.content);
  assert.deepEqual(decoded, payload);

  // Wrong passphrase fails decryption cleanly
  const wrongRoom = await deriveRoomSecrets('Pere Jututuba', 'vale-parool');
  assert.notEqual(wrongRoom.channelId, room.channelId);
  assert.equal(await decryptRoomPayload(wrongRoom.aesKey, ev.pubkey, room.channelId, ev.content), null);

  // AAD binding prevents re-signing ciphertext under another pubkey
  const otherId = await deriveRoomIdentity(generateMasterSeed(), room.channelId);
  assert.equal(await decryptRoomPayload(room.aesKey, otherId.pubkeyHex, room.channelId, ev.content), null);

  // Tampering event content invalidates Nostr signature
  assert.equal(await verifyNostrEvent({ ...ev, content: ev.content + 'x' }), false);
});

test('Per-room identities are unlinkable across different rooms', async () => {
  const seed = generateMasterSeed();
  const r1 = await deriveRoomSecrets('Tuba A', 'parool-1');
  const r2 = await deriveRoomSecrets('Tuba B', 'parool-2');
  const id1 = await deriveRoomIdentity(seed, r1.channelId);
  const id2 = await deriveRoomIdentity(seed, r2.channelId);
  assert.notEqual(id1.pubkeyHex, id2.pubkeyHex);
});

test('Invite URL encode/decode roundtrip', () => {
  const pass = generatePassphrase();
  assert.match(pass, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  const url = encodeInviteUrl('https://chat.example.ee/index.html', {
    name: 'Sõbrad 🚀',
    passphrase: pass,
    relays: ['wss://nos.lol'],
  });
  const hash = url.slice(url.indexOf('#'));
  const parsed = decodeInviteHash(hash);
  assert.deepEqual(parsed, {
    name: 'Sõbrad 🚀',
    passphrase: pass,
    relays: ['wss://nos.lol'],
  });
});
