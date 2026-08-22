#!/usr/bin/env node
/**
 * The trace viewer's web service.
 *
 * Two ways to use it:
 *   1) standalone:      node server.js  -> http://127.0.0.1:8080
 *   2) under the proxy: proxy.js requires this module, the UI lives under the /__trace
 *                       prefix, and one port covers both
 *
 *
 * It only reads traces/. With the proxy running, new requests arrive live; without it, the
 * history is still there to read.
 */

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.UI_PORT || 8080);
const HOST = process.env.UI_HOST || '127.0.0.1';
const TRACE_DIR = path.resolve(process.env.TRACE_DIR || path.join(__dirname, 'traces'));
const INDEX = path.join(TRACE_DIR, 'index.jsonl');
const MAX_RAW = 512 * 1024; // At most 512KB of any one raw file is sent back

// ---------------------------------------------------------------- Reading

function readIndex() {
  if (!fs.existsSync(INDEX)) return [];
  return fs
    .readFileSync(INDEX, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function loadJSON(dir, name) {
  const f = path.join(TRACE_DIR, dir, name);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

function loadRaw(dir, name) {
  const f = path.join(TRACE_DIR, dir, name);
  if (!fs.existsSync(f)) return null;
  const st = fs.statSync(f);
  const fd = fs.openSync(f, 'r');
  const len = Math.min(st.size, MAX_RAW);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, 0);
  fs.closeSync(fd);
  return { text: buf.toString('utf8'), bytes: st.size, truncated: st.size > MAX_RAW };
}

function loadEvents(dir, limit = 5000) {
  const f = path.join(TRACE_DIR, dir, 'response.stream.jsonl');
  if (!fs.existsSync(f)) return null;
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  const total = lines.length;
  return {
    total,
    truncated: total > limit,
    events: lines.slice(0, limit).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { event: 'parse_error', data: l };
      }
    }),
  };
}

/** Everything in one trace */
function loadTrace(id) {
  const meta = readIndex().find((r) => r.id === id);
  if (!meta) return null;
  const d = meta.dir;
  return {
    meta,
    request: loadJSON(d, 'request.json'),
    requestBody: loadJSON(d, 'request.body.json'),
    summary: loadJSON(d, 'request.summary.json'),
    responseHeaders: loadJSON(d, 'response.headers.json'),
    quota: loadJSON(d, 'quota.json'),
    reconstructed: loadJSON(d, 'response.reconstructed.json'),
    responseBody: loadJSON(d, 'response.body.json'),
    error: loadJSON(d, 'error.json'),
    stream: loadEvents(d),
    files: fs.existsSync(path.join(TRACE_DIR, d)) ? fs.readdirSync(path.join(TRACE_DIR, d)) : [],
  };
}

// ---------------------------------------------------------------- Live updates

const clients = new Set();
let lastSize = fs.existsSync(INDEX) ? fs.statSync(INDEX).size : 0;
let lastCount = readIndex().length;

setInterval(() => {
  if (!clients.size) return;
  let size = 0;
  try {
    size = fs.existsSync(INDEX) ? fs.statSync(INDEX).size : 0;
  } catch {
    return;
  }
  if (size === lastSize) return;
  lastSize = size;
  const rows = readIndex();
  const fresh = rows.slice(lastCount);
  lastCount = rows.length;
  for (const r of fresh) {
    const payload = `data: ${JSON.stringify(r)}\n\n`;
    for (const c of clients) c.write(payload);
  }
}, 800);

// ---------------------------------------------------------------- Authentication

/*
 * The interface shows **everybody's complete prompts**, so it cannot be left open. Two kinds
 * of request get through:
 *
 *   1) from a loopback address — a browser on this machine, curl on this machine, or
 *      `docker exec` into the container
 *   2) carrying the admin token — `Authorization: Bearer <PROXY_ADMIN_TOKEN>`, the
 *      `trace_admin` cookie, or a one-shot `?token=` (which sets the cookie and then 302s the
 *      query string away, so the token does not linger in the address bar, the history, or a
 *      referer)
 *
 *
 * "Loopback" is decided by the **socket peer**, never by `X-Forwarded-For` — a client writes
 * that header itself, and authenticating on it is not authentication at all. The cost: with
 * the proxy in a container and you reaching it from the host through a published port, the
 * peer is a bridge address and **not** loopback, so that case needs the token.
 *
 *
 * With no PROXY_ADMIN_TOKEN configured, loopback is the only way in — fail closed. Better
 * that you type one more docker exec than that everybody's conversations sit on the network
 * by default.
 */
const ADMIN_TOKEN = process.env.PROXY_ADMIN_TOKEN || '';
const AUTH_COOKIE = 'trace_admin';

function isLoopback(req) {
  const a = String(req.socket.remoteAddress || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/** Constant-time comparison, so response timing cannot be used to guess the token */
function tokenMatches(got) {
  if (!ADMIN_TOKEN || !got) return false;
  const a = Buffer.from(String(got));
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookieToken(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === AUTH_COOKIE) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return '';
}

/** 'ok' | 'grant' (a correct ?token=, so set the cookie) | 'deny' */
function uiAuth(req, url) {
  const bearer = String(req.headers.authorization || '');
  if (bearer.startsWith('Bearer ') && tokenMatches(bearer.slice(7))) return 'ok';
  if (tokenMatches(cookieToken(req))) return 'ok';
  if (tokenMatches(url.searchParams.get('token'))) return 'grant';
  return isLoopback(req) ? 'ok' : 'deny';
}

// ---------------------------------------------------------------- Routing

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

/**
 * Handle a UI request. `prefix` is where it is mounted ('' when standalone).
 * Returning false means "not a UI request", and the caller deals with it — which under the
 * proxy means forwarding it upstream.
 */
function handleUiRequest(req, res, prefix = '') {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let p = url.pathname;

  if (prefix) {
    if (p !== prefix && !p.startsWith(prefix + '/')) return false;
    p = p.slice(prefix.length) || '/';
  }

  // Authentication comes first, and covers the interface, /api/*, and SSE alike. Missing one
  // is the same as having none.
  const verdict = uiAuth(req, url);
  if (verdict === 'deny') {
    send(
      res,
      401,
      {
        error: 'authorization required',
        how: ADMIN_TOKEN
          ? 'Local access is allowed as is. From elsewhere, send Authorization: Bearer '
            + '<PROXY_ADMIN_TOKEN>, or append ?token=<PROXY_ADMIN_TOKEN> to trade it for a cookie'
          : 'Local access is allowed as is. Access from elsewhere needs PROXY_ADMIN_TOKEN configured on the proxy first.',
      },
    );
    return true;
  }
  if (verdict === 'grant') {
    // The token appears in a URL exactly once: it becomes an HttpOnly cookie and the query
    // string is 302'd away immediately. No Secure flag — this interface is a local or
    // internal plain-http tool, and setting it would only lock people out.
    url.searchParams.delete('token');
    const to = (prefix || '') + p + (url.searchParams.toString() ? `?${url.searchParams}` : '');
    res.writeHead(302, {
      location: to,
      'set-cookie': `${AUTH_COOKIE}=${encodeURIComponent(ADMIN_TOKEN)}; HttpOnly; SameSite=Lax; Path=${prefix || '/'}`,
      'cache-control': 'no-store',
    });
    res.end();
    return true;
  }

  if (p === '/' || p === '/index.html') {
    const f = path.join(__dirname, 'ui.html');
    if (!fs.existsSync(f)) {
      send(res, 500, 'ui.html is missing', 'text/plain; charset=utf-8');
      return true;
    }
    const html = fs.readFileSync(f, 'utf8').replace('__API_BASE__', prefix);
    send(res, 200, html, 'text/html; charset=utf-8');
    return true;
  }

  if (p === '/api/index') {
    send(res, 200, { traceDir: TRACE_DIR, rows: readIndex() });
    return true;
  }

  if (p.startsWith('/api/trace/')) {
    const id = Number(p.slice('/api/trace/'.length));
    const t = loadTrace(id);
    t ? send(res, 200, t) : send(res, 404, { error: 'not found' });
    return true;
  }

  if (p.startsWith('/api/raw/')) {
    const [, , , id, name] = p.split('/');
    const meta = readIndex().find((r) => r.id === Number(id));
    if (!meta) { send(res, 404, { error: 'not found' }); return true; }
    if (!/^[a-z0-9._-]+$/i.test(name)) { send(res, 400, { error: 'bad name' }); return true; }
    const raw = loadRaw(meta.dir, name);
    raw ? send(res, 200, raw) : send(res, 404, { error: 'no file' });
    return true;
  }

  if (p === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    clients.add(res);
    const ka = setInterval(() => res.write(': ka\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ka);
      clients.delete(res);
    });
    return true;
  }

  // With a prefix, unknown paths under it belong to the UI. Same when standalone.
  send(res, 404, { error: 'not found' });
  return true;
}

module.exports = { handleUiRequest, readIndex, loadTrace, TRACE_DIR };

if (require.main === module) {
  http
    .createServer((req, res) => handleUiRequest(req, res, ''))
    .listen(PORT, HOST, () => {
      console.log(`\n  trace viewer  →  http://${HOST}:${PORT}`);
      console.log(`  reading       →  ${TRACE_DIR}`);
      console.log(`  ${readIndex().length} records already stored; new requests arrive live`);
      console.log(
        ADMIN_TOKEN
          ? '  auth          →  loopback allowed; from elsewhere use a Bearer token or ?token=<PROXY_ADMIN_TOKEN>\n'
          : '  auth          →  loopback only (no PROXY_ADMIN_TOKEN configured, so everything else is a 401)\n',
      );
    });
}
