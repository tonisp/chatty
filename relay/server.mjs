#!/usr/bin/env node
// DecLoc Chat Self-Hosted Server & Nostr Relay (Zero external dependencies!)
// Serves BOTH:
//   1) DecLoc Chat static web app (HTML/CSS/JS PWA) over HTTP
//   2) Private Nostr Relay (NIP-01 + NIP-09 deletion + NIP-11) over WebSocket (/relay and /)
// Uses Node.js 22+ built-in SQLite (node:sqlite) with automatic NDJSON fallback.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyNostrEvent } from '../js/crypto.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_ROOT = path.resolve(__dirname, '..');

// --- CLI Arguments & Configuration ---

function parseArgs(argv) {
  const opts = {
    port: Number(process.env.PORT || 7777),
    host: process.env.HOST || '127.0.0.1',
    dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
    serveStatic: process.env.NO_STATIC !== '1',
    allowAllKinds: process.env.ALLOW_ALL_KINDS === '1',
    maxEventBytes: Number(process.env.MAX_EVENT_BYTES || 65536),
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--port' || a === '-p') && argv[i + 1]) opts.port = Number(argv[++i]);
    else if ((a === '--host' || a === '-H') && argv[i + 1]) opts.host = argv[++i];
    else if ((a === '--data' || a === '-d') && argv[i + 1]) opts.dataDir = path.resolve(argv[++i]);
    else if (a === '--no-static') opts.serveStatic = false;
    else if (a === '--allow-all-kinds') opts.allowAllKinds = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        'DecLoc Chat Self-Hosted Server & Nostr Relay\n\n' +
          'Usage: node relay/server.mjs [options]\n\n' +
          'Options:\n' +
          '  -p, --port <num>     HTTP/WebSocket port (default: 7777)\n' +
          '  -H, --host <addr>    Bind address (default: 127.0.0.1; use 0.0.0.0 for LAN)\n' +
          '  -d, --data <dir>     Database directory (default: ./relay/data)\n' +
          '  --no-static          Run Nostr relay only (do not serve web UI)\n' +
          '  --allow-all-kinds    Accept all Nostr event kinds (default: only 5, 42, 20042)\n'
      );
      process.exit(0);
    }
  }
  return opts;
}

const ALLOWED_KINDS = new Set([5, 42, 20042]);

// --- Storage Engine (Built-in node:sqlite with NDJSON fallback) ---

async function createEventStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });

  try {
    const { DatabaseSync } = await import('node:sqlite');
    const dbPath = path.join(dataDir, 'decloc-relay.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        pubkey TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        kind INTEGER NOT NULL,
        channel_id TEXT,
        tags_json TEXT NOT NULL,
        content TEXT NOT NULL,
        sig TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_channel_time ON events(channel_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_pubkey ON events(pubkey);
      CREATE INDEX IF NOT EXISTS idx_events_kind_time ON events(kind, created_at DESC);
    `);

    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO events (id, pubkey, created_at, kind, channel_id, tags_json, content, sig)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const deleteByOwnerStmt = db.prepare(`DELETE FROM events WHERE id = ? AND pubkey = ?`);
    const countStmt = db.prepare(`SELECT COUNT(*) AS cnt FROM events`);

    function rowToEvent(row) {
      return {
        id: row.id,
        pubkey: row.pubkey,
        created_at: row.created_at,
        kind: row.kind,
        tags: JSON.parse(row.tags_json),
        content: row.content,
        sig: row.sig,
      };
    }

    return {
      backend: 'sqlite',
      location: dbPath,
      save(ev) {
        const eTag = ev.tags.find((t) => Array.isArray(t) && t[0] === 'e' && typeof t[1] === 'string');
        const channelId = eTag ? eTag[1] : null;
        insertStmt.run(
          ev.id,
          ev.pubkey,
          ev.created_at,
          ev.kind,
          channelId,
          JSON.stringify(ev.tags),
          ev.content,
          ev.sig
        );
      },
      deleteByOwner(targetIds, pubkey) {
        let deleted = 0;
        for (const id of targetIds) {
          const info = deleteByOwnerStmt.run(id, pubkey);
          deleted += Number(info.changes || 0);
        }
        return deleted;
      },
      query(filter) {
        const clauses = [];
        const params = [];

        if (Array.isArray(filter.ids) && filter.ids.length > 0) {
          clauses.push(`id IN (${filter.ids.map(() => '?').join(',')})`);
          params.push(...filter.ids);
        }
        if (Array.isArray(filter.authors) && filter.authors.length > 0) {
          clauses.push(`pubkey IN (${filter.authors.map(() => '?').join(',')})`);
          params.push(...filter.authors);
        }
        if (Array.isArray(filter.kinds) && filter.kinds.length > 0) {
          clauses.push(`kind IN (${filter.kinds.map(() => '?').join(',')})`);
          params.push(...filter.kinds);
        }
        if (Array.isArray(filter['#e']) && filter['#e'].length > 0) {
          clauses.push(`channel_id IN (${filter['#e'].map(() => '?').join(',')})`);
          params.push(...filter['#e']);
        }
        if (typeof filter.since === 'number') {
          clauses.push(`created_at >= ?`);
          params.push(filter.since);
        }
        if (typeof filter.until === 'number') {
          clauses.push(`created_at <= ?`);
          params.push(filter.until);
        }

        const limit = Math.min(Math.max(Number(filter.limit) || 200, 1), 500);
        const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
        const sql = `SELECT id, pubkey, created_at, kind, tags_json, content, sig FROM events ${where} ORDER BY created_at DESC, id DESC LIMIT ?`;
        const rows = db.prepare(sql).all(...params, limit);
        return rows.reverse().map(rowToEvent);
      },
      count() {
        return Number(countStmt.get().cnt || 0);
      },
      close() {
        db.close();
      },
    };
  } catch {
    // Pure-JS fallback for Node < 22.5 without node:sqlite
    const filePath = path.join(dataDir, 'events.ndjson');
    const byId = new Map();
    if (fs.existsSync(filePath)) {
      const lines = fs.readFileSync(filePath, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev && typeof ev.id === 'string') byId.set(ev.id, ev);
        } catch {
          // ignore corrupted line
        }
      }
    }

    function rewriteAll() {
      const tmp = filePath + '.tmp';
      const content = [...byId.values()].map((e) => JSON.stringify(e)).join('\n') + (byId.size ? '\n' : '');
      fs.writeFileSync(tmp, content, 'utf8');
      fs.renameSync(tmp, filePath);
    }

    return {
      backend: 'ndjson',
      location: filePath,
      save(ev) {
        if (byId.has(ev.id)) return;
        byId.set(ev.id, ev);
        fs.appendFileSync(filePath, JSON.stringify(ev) + '\n', 'utf8');
      },
      deleteByOwner(targetIds, pubkey) {
        let deleted = 0;
        for (const id of targetIds) {
          const existing = byId.get(id);
          if (existing && existing.pubkey === pubkey) {
            byId.delete(id);
            deleted++;
          }
        }
        if (deleted > 0) rewriteAll();
        return deleted;
      },
      query(filter) {
        const limit = Math.min(Math.max(Number(filter.limit) || 200, 1), 500);
        const matched = [];
        for (const ev of byId.values()) {
          if (matchesFilter(ev, filter)) matched.push(ev);
        }
        matched.sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id));
        return matched.slice(0, limit).reverse();
      },
      count() {
        return byId.size;
      },
      close() {},
    };
  }
}

function matchesFilter(ev, filter) {
  if (!filter || typeof filter !== 'object') return false;
  if (Array.isArray(filter.ids) && filter.ids.length > 0 && !filter.ids.includes(ev.id)) return false;
  if (Array.isArray(filter.authors) && filter.authors.length > 0 && !filter.authors.includes(ev.pubkey)) return false;
  if (Array.isArray(filter.kinds) && filter.kinds.length > 0 && !filter.kinds.includes(ev.kind)) return false;
  if (typeof filter.since === 'number' && ev.created_at < filter.since) return false;
  if (typeof filter.until === 'number' && ev.created_at > filter.until) return false;
  if (Array.isArray(filter['#e']) && filter['#e'].length > 0) {
    const eTags = ev.tags.filter((t) => Array.isArray(t) && t[0] === 'e').map((t) => t[1]);
    if (!filter['#e'].some((id) => eTags.includes(id))) return false;
  }
  return true;
}

// --- RFC 6455 WebSocket Framing Helpers ---

function buildWsFrame(opcode, payloadBuf) {
  const len = payloadBuf.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payloadBuf]);
}

function wsSendText(socket, text) {
  if (socket.destroyed || !socket.writable) return;
  try {
    socket.write(buildWsFrame(0x01, Buffer.from(text, 'utf8')));
  } catch {
    // ignore broken pipe
  }
}

function wsSendControl(socket, opcode, payload = Buffer.alloc(0)) {
  if (socket.destroyed || !socket.writable) return;
  try {
    socket.write(buildWsFrame(opcode, payload.subarray(0, 125)));
  } catch {
    // ignore
  }
}

// --- Static File Serving ---

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const BLOCKED_PREFIXES = ['/relay', '/tests', '/.git', '/node_modules'];

function serveStaticFile(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  try {
    rel = decodeURIComponent(rel);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  // Block hidden files, traversal, and server/test directories
  if (rel.includes('..') || rel.includes('\0') || rel.split('/').some((seg) => seg.startsWith('.'))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  for (const blocked of BLOCKED_PREFIXES) {
    if (rel === blocked || rel.startsWith(blocked + '/')) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
  }

  const abs = path.resolve(WEB_ROOT, '.' + rel);
  if (!abs.startsWith(WEB_ROOT + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(abs, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': ext === '.html' || rel === '/config.js' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(abs).pipe(res);
  });
}

// --- Main Server Factory (exportable for tests!) ---

export async function createDecLocServer(userOpts = {}) {
  const opts = {
    port: 7777,
    host: '127.0.0.1',
    dataDir: path.join(__dirname, 'data'),
    serveStatic: true,
    allowAllKinds: false,
    maxEventBytes: 65536,
    ...userOpts,
  };

  const store = await createEventStore(opts.dataDir);
  const clients = new Set();
  const startedAt = Date.now();
  const MAX_FRAME_BYTES = Math.max(opts.maxEventBytes * 2, 131072);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const accept = String(req.headers.accept || '');

    // NIP-11 Relay Information Document
    if (accept.includes('application/nostr+json') && (url.pathname === '/' || url.pathname === '/relay')) {
      res.writeHead(200, {
        'Content-Type': 'application/nostr+json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(
        JSON.stringify({
          name: 'DecLoc Private Relay',
          description: 'Self-hosted encrypted chat relay for DecLoc Chat (NIP-01, NIP-09, NIP-28).',
          supported_nips: [1, 9, 11, 28],
          software: 'decloc-relay',
          version: '1.0.0',
        })
      );
      return;
    }

    // Auto-discovery endpoint so DecLoc Chat frontend hosted here uses this relay automatically
    if (url.pathname === '/decloc-relay.json') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(
        JSON.stringify({
          selfHostedRelay: true,
          wsPath: '/relay',
          storage: store.backend,
        })
      );
      return;
    }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(
        JSON.stringify({
          ok: true,
          clients: clients.size,
          storedEvents: store.count(),
          storage: store.backend,
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        })
      );
      return;
    }

    if (opts.serveStatic) {
      serveStaticFile(req, res, url.pathname);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('DecLoc Chat Nostr Relay running. Connect via WebSocket (wss://...).\n');
    }
  });

  // WebSocket Upgrade Handler (/relay and /)
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== '/relay' && url.pathname !== '/') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

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

    const client = {
      socket,
      subs: new Map(), // subId -> filters[]
      buf: Buffer.alloc(0),
      fragChunks: null,
      alive: true,
      msgTimestamps: [],
    };
    clients.add(client);

    socket.on('data', (chunk) => {
      client.alive = true;
      client.buf = Buffer.concat([client.buf, chunk]);
      if (client.buf.length > MAX_FRAME_BYTES * 2) {
        wsSendControl(socket, 0x08);
        socket.destroy();
        return;
      }
      processClientBuffer(client);
    });

    const cleanup = () => {
      clients.delete(client);
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  // Periodic WebSocket Ping keepalive (keeps Cloudflare Tunnel & mobile connections alive)
  const pingInterval = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.socket.destroy();
        clients.delete(c);
        continue;
      }
      c.alive = false;
      wsSendControl(c.socket, 0x09);
    }
  }, 25000);
  pingInterval.unref();

  function processClientBuffer(client) {
    while (client.buf.length >= 2) {
      const b0 = client.buf[0];
      const b1 = client.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (client.buf.length < 4) return;
        len = client.buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (client.buf.length < 10) return;
        const bigLen = client.buf.readBigUInt64BE(2);
        if (bigLen > BigInt(MAX_FRAME_BYTES)) {
          wsSendControl(client.socket, 0x08);
          client.socket.destroy();
          return;
        }
        len = Number(bigLen);
        offset = 10;
      }

      if (len > MAX_FRAME_BYTES) {
        wsSendControl(client.socket, 0x08);
        client.socket.destroy();
        return;
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
        wsSendControl(client.socket, 0x08);
        client.socket.end();
        return;
      }
      if (opcode === 0x09) {
        // Ping -> reply Pong with same payload
        wsSendControl(client.socket, 0x0a, payload);
        continue;
      }
      if (opcode === 0x0a) {
        client.alive = true;
        continue;
      }

      if (opcode === 0x01) {
        if (fin) {
          handleNostrText(client, payload.toString('utf8'));
        } else {
          client.fragChunks = [payload];
        }
      } else if (opcode === 0x00 && client.fragChunks) {
        client.fragChunks.push(payload);
        const total = client.fragChunks.reduce((acc, b) => acc + b.length, 0);
        if (total > MAX_FRAME_BYTES) {
          wsSendControl(client.socket, 0x08);
          client.socket.destroy();
          return;
        }
        if (fin) {
          const full = Buffer.concat(client.fragChunks);
          client.fragChunks = null;
          handleNostrText(client, full.toString('utf8'));
        }
      }
    }
  }

  function isRateLimited(client) {
    const now = Date.now();
    client.msgTimestamps = client.msgTimestamps.filter((ts) => now - ts < 10000);
    if (client.msgTimestamps.length >= 80) return true;
    client.msgTimestamps.push(now);
    return false;
  }

  async function handleNostrText(client, text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      wsSendText(client.socket, JSON.stringify(['NOTICE', 'invalid JSON']));
      return;
    }
    if (!Array.isArray(msg) || msg.length < 2) return;

    const cmd = msg[0];

    if (cmd === 'REQ' && typeof msg[1] === 'string') {
      const subId = msg[1].slice(0, 64);
      const filters = msg.slice(2).filter((f) => f && typeof f === 'object').slice(0, 10);
      if (client.subs.size > 20 && !client.subs.has(subId)) {
        wsSendText(client.socket, JSON.stringify(['CLOSED', subId, 'too many subscriptions']));
        return;
      }
      client.subs.set(subId, filters);

      const sent = new Set();
      for (const f of filters) {
        const events = store.query(f);
        for (const ev of events) {
          if (sent.has(ev.id)) continue;
          sent.add(ev.id);
          wsSendText(client.socket, JSON.stringify(['EVENT', subId, ev]));
        }
      }
      wsSendText(client.socket, JSON.stringify(['EOSE', subId]));
      return;
    }

    if (cmd === 'CLOSE' && typeof msg[1] === 'string') {
      client.subs.delete(msg[1]);
      return;
    }

    if (cmd === 'EVENT' && msg[1] && typeof msg[1] === 'object') {
      const ev = msg[1];
      const evId = typeof ev.id === 'string' ? ev.id : '';

      if (isRateLimited(client)) {
        wsSendText(client.socket, JSON.stringify(['OK', evId, false, 'rate-limited: slow down']));
        return;
      }
      if (Buffer.byteLength(text, 'utf8') > opts.maxEventBytes) {
        wsSendText(client.socket, JSON.stringify(['OK', evId, false, 'invalid: event too large']));
        return;
      }
      if (!opts.allowAllKinds && !ALLOWED_KINDS.has(ev.kind)) {
        wsSendText(client.socket, JSON.stringify(['OK', evId, false, 'blocked: unsupported event kind']));
        return;
      }

      const valid = await verifyNostrEvent(ev);
      if (!valid) {
        wsSendText(client.socket, JSON.stringify(['OK', evId, false, 'invalid: bad id or schnorr signature']));
        return;
      }

      // NIP-09 Event Deletion: permanently erase ONLY events authored by ev.pubkey
      if (ev.kind === 5) {
        const targetIds = ev.tags
          .filter((t) => Array.isArray(t) && t[0] === 'e' && typeof t[1] === 'string')
          .map((t) => t[1]);
        const deleted = store.deleteByOwner(targetIds, ev.pubkey);
        wsSendText(client.socket, JSON.stringify(['OK', ev.id, true, `deleted ${deleted}`]));
        return;
      }

      // Ephemeral events (20000..29999) are broadcast live without persisting
      const isEphemeral = ev.kind >= 20000 && ev.kind < 30000;
      if (!isEphemeral) {
        store.save(ev);
      }

      wsSendText(client.socket, JSON.stringify(['OK', ev.id, true, '']));

      // Fan out to all matching live subscribers
      for (const c of clients) {
        for (const [subId, filters] of c.subs.entries()) {
          if (filters.some((f) => matchesFilter(ev, f))) {
            wsSendText(c.socket, JSON.stringify(['EVENT', subId, ev]));
          }
        }
      }
    }
  }

  return {
    server,
    store,
    start() {
      return new Promise((resolve) => {
        server.listen(opts.port, opts.host, () => {
          const addr = server.address();
          resolve({
            host: addr.address,
            port: addr.port,
            httpUrl: `http://${addr.address}:${addr.port}`,
            wsUrl: `ws://${addr.address}:${addr.port}/relay`,
            storage: store.backend,
            storageLocation: store.location,
          });
        });
      });
    },
    stop() {
      clearInterval(pingInterval);
      for (const c of clients) c.socket.destroy();
      clients.clear();
      return new Promise((resolve) => {
        server.close(() => {
          store.close();
          resolve();
        });
      });
    },
  };
}

// Run directly when invoked from CLI
const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  const instance = await createDecLocServer(opts);
  const info = await instance.start();

  console.log(`\n🚀 DecLoc Chat server käivitatud!`);
  console.log(`   Veebileht:  ${info.httpUrl}`);
  console.log(`   Nostr WSS:  ${info.wsUrl}`);
  console.log(`   Andmebaas:  ${info.storage} (${info.storageLocation})`);
  console.log(`   Peatamine:  Ctrl+C\n`);

  const shutdown = async () => {
    console.log('\nPeatan DecLoc Chat serveri…');
    await instance.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
