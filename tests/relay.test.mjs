import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import {
  deriveRoomSecrets,
  deriveRoomIdentity,
  encryptRoomPayload,
  decryptRoomPayload,
  signNostrEvent,
  generateMasterSeed,
} from '../js/crypto.js';
import { RelayPool } from '../js/nostr.js';

// Minimal RFC 6455 WebSocket server implementing Nostr NIP-01 (REQ, EVENT, OK, EOSE)
// so we can test the full RelayPool + E2EE protocol completely offline in Node.js!
function createMockNostrRelay() {
  const storedEvents = [];
  const clients = new Set();

  function sendFrame(socket, text) {
    const data = Buffer.from(text, 'utf8');
    let header;
    if (data.length < 126) {
      header = Buffer.from([0x81, data.length]);
    } else if (data.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(data.length), 2);
    }
    socket.write(Buffer.concat([header, data]));
  }

  function matchesFilter(ev, filter) {
    if (filter.kinds && !filter.kinds.includes(ev.kind)) return false;
    if (filter['#e']) {
      const eTags = ev.tags.filter((t) => t[0] === 'e').map((t) => t[1]);
      if (!filter['#e'].some((id) => eTags.includes(id))) return false;
    }
    return true;
  }

  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    const client = { socket, subs: new Map(), buf: Buffer.alloc(0) };
    clients.add(client);

    socket.on('data', (chunk) => {
      client.buf = Buffer.concat([client.buf, chunk]);
      while (client.buf.length >= 2) {
        const opcode = client.buf[0] & 0x0f;
        const masked = (client.buf[1] & 0x80) !== 0;
        let len = client.buf[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (client.buf.length < 4) return;
          len = client.buf.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (client.buf.length < 10) return;
          len = Number(client.buf.readBigUInt64BE(2));
          offset = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (client.buf.length < offset + maskLen + len) return;

        let payload = client.buf.subarray(offset + maskLen, offset + maskLen + len);
        if (masked) {
          const mask = client.buf.subarray(offset, offset + 4);
          payload = Buffer.from(payload);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        }
        client.buf = client.buf.subarray(offset + maskLen + len);

        if (opcode === 0x08) {
          socket.end();
          return;
        }
        if (opcode !== 0x01) continue;

        const msg = JSON.parse(payload.toString('utf8'));
        if (msg[0] === 'REQ') {
          const subId = msg[1];
          const filters = msg.slice(2);
          client.subs.set(subId, filters);
          for (const ev of storedEvents) {
            if (filters.some((f) => matchesFilter(ev, f))) {
              sendFrame(socket, JSON.stringify(['EVENT', subId, ev]));
            }
          }
          sendFrame(socket, JSON.stringify(['EOSE', subId]));
        } else if (msg[0] === 'CLOSE') {
          client.subs.delete(msg[1]);
        } else if (msg[0] === 'EVENT') {
          const ev = msg[1];
          if (ev.kind < 20000 || ev.kind >= 30000) {
            storedEvents.push(ev);
          }
          sendFrame(socket, JSON.stringify(['OK', ev.id, true, '']));
          for (const c of clients) {
            for (const [subId, filters] of c.subs.entries()) {
              if (filters.some((f) => matchesFilter(ev, f))) {
                sendFrame(c.socket, JSON.stringify(['EVENT', subId, ev]));
              }
            }
          }
        }
      }
    });

    socket.on('close', () => clients.delete(client));
    socket.on('error', () => clients.delete(client));
  });

  return {
    start: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          resolve(`ws://127.0.0.1:${server.address().port}`);
        });
      }),
    stop: () =>
      new Promise((resolve) => {
        for (const c of clients) c.socket.destroy();
        server.close(() => resolve());
      }),
    storedEvents,
  };
}

test('End-to-end encrypted room exchange across 2 relays with deduplication and OK acks', async () => {
  const relay1 = createMockNostrRelay();
  const relay2 = createMockNostrRelay();
  const url1 = await relay1.start();
  const url2 = await relay2.start();

  try {
    const room = await deriveRoomSecrets('Sõbrad', 'salajane-kood-99');
    const aliceId = await deriveRoomIdentity(generateMasterSeed(), room.channelId);
    const bobId = await deriveRoomIdentity(generateMasterSeed(), room.channelId);

    const bobReceived = [];
    const aliceAcks = [];

    let aliceReadyResolve;
    const aliceReady = new Promise((r) => (aliceReadyResolve = r));
    let bobReadyResolve;
    const bobReady = new Promise((r) => (bobReadyResolve = r));

    let bobMsgResolve;
    const bobGotMsg = new Promise((r) => (bobMsgResolve = r));
    let ack2Resolve;
    const gotTwoAcks = new Promise((r) => (ack2Resolve = r));

    const alicePool = new RelayPool([url1, url2], {
      onStatusChange: (statuses) => {
        if (statuses.filter((s) => s.status === 'connected').length === 2) aliceReadyResolve();
      },
      onAck: (id, count) => {
        aliceAcks.push({ id, count });
        if (count === 2) ack2Resolve();
      },
    });

    const bobPool = new RelayPool([url1, url2], {
      onStatusChange: (statuses) => {
        if (statuses.filter((s) => s.status === 'connected').length === 2) bobReadyResolve();
      },
      onEvent: async (ev) => {
        const pt = await decryptRoomPayload(room.aesKey, ev.pubkey, room.channelId, ev.content);
        if (pt) {
          bobReceived.push({ ev, pt });
          bobMsgResolve();
        }
      },
    });

    await Promise.all([aliceReady, bobReady]);
    alicePool.setSubscribedChannels([room.channelId]);
    bobPool.setSubscribedChannels([room.channelId]);

    // Give mock relays a moment to register REQ subscriptions
    await new Promise((r) => setTimeout(r, 60));

    const msgPayload = { v: 1, t: 'msg', name: 'Mari', text: 'Tere Jüri! 🔒', ts: Date.now() };
    const encrypted = await encryptRoomPayload(room.aesKey, aliceId.pubkeyHex, room.channelId, msgPayload);
    const ev = await signNostrEvent(
      {
        kind: 42,
        tags: [['e', room.channelId, '', 'root']],
        content: encrypted,
      },
      aliceId.privKeyBytes
    );

    const sentTo = alicePool.publish(ev);
    assert.equal(sentTo, 2);

    await Promise.all([bobGotMsg, gotTwoAcks]);
    // Wait briefly to confirm deduplication prevents duplicate delivery from relay 2
    await new Promise((r) => setTimeout(r, 80));

    assert.equal(bobReceived.length, 1);
    assert.equal(bobReceived[0].pt.name, 'Mari');
    assert.equal(bobReceived[0].pt.text, 'Tere Jüri! 🔒');
    assert.equal(bobReceived[0].ev.pubkey, aliceId.pubkeyHex);
    assert.notEqual(aliceId.pubkeyHex, bobId.pubkeyHex);

    // Confirm relay only ever saw opaque ciphertext (no room name, no sender name, no text)
    const rawStored = JSON.stringify(relay1.storedEvents);
    assert.equal(rawStored.includes('Tere Jüri'), false);
    assert.equal(rawStored.includes('Mari'), false);
    assert.equal(rawStored.includes('Sõbrad'), false);

    alicePool.destroy();
    bobPool.destroy();
  } finally {
    await relay1.stop();
    await relay2.stop();
  }
});
