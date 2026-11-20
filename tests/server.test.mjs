import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDecLocServer } from '../relay/server.mjs';
import {
  deriveRoomSecrets,
  deriveRoomIdentity,
  encryptRoomPayload,
  decryptRoomPayload,
  signNostrEvent,
  generateMasterSeed,
} from '../js/crypto.js';
import { RelayPool } from '../js/nostr.js';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'decloc-relay-test-'));
}

test('DecLoc Chat server serves static app, auto-discovery, NIP-11, and blocks private server paths', async () => {
  const dataDir = makeTempDir();
  const srv = await createDecLocServer({ port: 0, host: '127.0.0.1', dataDir });
  const info = await srv.start();

  try {
    // 1. Serves index.html
    const home = await fetch(`${info.httpUrl}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    const html = await home.text();
    assert.ok(html.includes('js/app.js'));

    // 2. Serves self-hosted relay auto-discovery JSON
    const disc = await fetch(`${info.httpUrl}/decloc-relay.json`);
    assert.equal(disc.status, 200);
    const discJson = await disc.json();
    assert.equal(discJson.selfHostedRelay, true);
    assert.equal(discJson.wsPath, '/relay');

    // 3. Serves health endpoint
    const health = await fetch(`${info.httpUrl}/health`);
    assert.equal(health.status, 200);
    const healthJson = await health.json();
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.storage, 'sqlite');

    // 4. Serves NIP-11 relay info
    const nip11 = await fetch(`${info.httpUrl}/relay`, {
      headers: { Accept: 'application/nostr+json' },
    });
    assert.equal(nip11.status, 200);
    const nip11Json = await nip11.json();
    assert.ok(nip11Json.supported_nips.includes(9));

    // 5. Blocks access to server code, database dir, tests, and hidden files
    assert.equal((await fetch(`${info.httpUrl}/relay/server.mjs`)).status, 403);
    assert.equal((await fetch(`${info.httpUrl}/tests/crypto.test.mjs`)).status, 403);
    assert.equal((await fetch(`${info.httpUrl}/.gitignore`)).status, 403);
  } finally {
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('DecLoc Chat SQLite relay persists across restarts, blocks spam/bad sigs, handles ephemeral & NIP-09 self-only deletion', async () => {
  const dataDir = makeTempDir();
  const room = await deriveRoomSecrets('Termux Tuba', 'salakood-2026');
  const aliceId = await deriveRoomIdentity(generateMasterSeed(), room.channelId);
  const bobId = await deriveRoomIdentity(generateMasterSeed(), room.channelId);

  let srv = await createDecLocServer({ port: 0, host: '127.0.0.1', dataDir });
  let info = await srv.start();
  let aliceMsgEv;

  try {
    // Connect Alice & Bob via real RelayPool to /relay
    const bobMsgs = [];
    const bobEphemeral = [];
    let readyA, readyB;
    const pA = new Promise((r) => (readyA = r));
    const pB = new Promise((r) => (readyB = r));

    const alicePool = new RelayPool([info.wsUrl], {
      onStatusChange: (s) => {
        if (s.some((x) => x.status === 'connected')) readyA();
      },
    });
    const bobPool = new RelayPool([info.wsUrl], {
      onStatusChange: (s) => {
        if (s.some((x) => x.status === 'connected')) readyB();
      },
      onEvent: async (ev) => {
        const pt = await decryptRoomPayload(room.aesKey, ev.pubkey, room.channelId, ev.content);
        if (!pt) return;
        if (ev.kind === 20042) bobEphemeral.push(pt);
        else bobMsgs.push({ ev, pt });
      },
    });

    await Promise.all([pA, pB]);
    alicePool.setSubscribedChannels([room.channelId]);
    bobPool.setSubscribedChannels([room.channelId]);
    await new Promise((r) => setTimeout(r, 60));

    // 1. Alice sends persisted encrypted message (kind 42)
    aliceMsgEv = await signNostrEvent(
      {
        kind: 42,
        tags: [['e', room.channelId, '', 'root']],
        content: await encryptRoomPayload(room.aesKey, aliceId.pubkeyHex, room.channelId, {
          v: 1,
          t: 'msg',
          name: 'Mari',
          text: 'Säilib üle restardi!',
          ts: Date.now(),
        }),
      },
      aliceId.privKeyBytes
    );
    alicePool.publish(aliceMsgEv);

    // 2. Alice sends ephemeral typing signal (kind 20042) — delivered live, NOT persisted
    const typingEv = await signNostrEvent(
      {
        kind: 20042,
        tags: [['e', room.channelId]],
        content: await encryptRoomPayload(room.aesKey, aliceId.pubkeyHex, room.channelId, {
          v: 1,
          t: 'typing',
          name: 'Mari',
          ts: Date.now(),
        }),
      },
      aliceId.privKeyBytes
    );
    alicePool.publish(typingEv);

    // 3. Spam kind: 1 and tampered signature must NOT be stored
    const spamEv = await signNostrEvent({ kind: 1, tags: [], content: 'spam' }, bobId.privKeyBytes);
    const tamperedEv = { ...aliceMsgEv, content: aliceMsgEv.content + 'bad' };
    alicePool.publish(spamEv);
    alicePool.publish(tamperedEv);

    await new Promise((r) => setTimeout(r, 150));

    assert.equal(bobMsgs.length, 1);
    assert.equal(bobMsgs[0].pt.text, 'Säilib üle restardi!');
    assert.equal(bobEphemeral.length, 1);
    assert.equal(bobEphemeral[0].t, 'typing');
    assert.equal(srv.store.count(), 1); // ONLY aliceMsgEv persisted!

    // 4. Bob tries forged NIP-09 deletion of Alice's event -> MUST FAIL
    const forgedDel = await signNostrEvent(
      { kind: 5, tags: [['e', aliceMsgEv.id], ['k', '42']], content: '' },
      bobId.privKeyBytes
    );
    bobPool.publish(forgedDel);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(srv.store.count(), 1);

    alicePool.destroy();
    bobPool.destroy();
  } finally {
    await srv.stop();
  }

  // 5. Simulate phone reboot: start brand new server instance pointing at SAME dataDir!
  srv = await createDecLocServer({ port: 0, host: '127.0.0.1', dataDir });
  info = await srv.start();

  try {
    assert.equal(srv.store.count(), 1);

    // Fresh client connects after reboot and receives Alice's persisted message from SQLite
    const recovered = [];
    let readyC;
    const pC = new Promise((r) => (readyC = r));
    const clientPool = new RelayPool([info.wsUrl], {
      onStatusChange: (s) => {
        if (s.some((x) => x.status === 'connected')) readyC();
      },
      onEvent: async (ev) => {
        const pt = await decryptRoomPayload(room.aesKey, ev.pubkey, room.channelId, ev.content);
        if (pt) recovered.push(pt);
      },
    });
    await pC;
    clientPool.setSubscribedChannels([room.channelId]);
    await new Promise((r) => setTimeout(r, 120));

    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].text, 'Säilib üle restardi!');

    // 6. Alice now legitimately deletes her own message via NIP-09 -> physically wiped from SQLite!
    const legitDel = await signNostrEvent(
      { kind: 5, tags: [['e', aliceMsgEv.id], ['k', '42']], content: '' },
      aliceId.privKeyBytes
    );
    clientPool.publish(legitDel);
    await new Promise((r) => setTimeout(r, 120));

    assert.equal(srv.store.count(), 0);
    clientPool.destroy();
  } finally {
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
