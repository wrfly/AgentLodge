#!/usr/bin/env node
/**
 * A TLS fingerprint probe: grab the ClientHello from the first TCP packet, parse it, and
 * compute JA3 / JA4.
 *
 *   node ja3-probe.js 8894 /tmp/out.jsonl
 *
 * Then point the client under test at it. The TLS handshake fails, but the ClientHello has
 * already been sent, which is all this needs:
 *   JA3_LABEL=claude   ANTHROPIC_BASE_URL=https://127.0.0.1:8894 claude -p x
 *   JA3_LABEL=proxy    UPSTREAM_URL=https://127.0.0.1:8894 node proxy.js
 *   JA3_LABEL=node     node -e 'require("node:https").request({host:"127.0.0.1",port:8894}).on("error",()=>{}).end()'
 *
 * A failed handshake means no API call happens at all, so this costs nothing.
 */

// Capture the raw ClientHello bytes, parse them, and compute JA3 / JA4
const net = require('node:net');
const crypto = require('node:crypto');
const fs = require('node:fs');

const PORT = Number(process.argv[2] || 8894);
const OUT = process.argv[3] || '/tmp/ja3-out.jsonl';

const isGrease = (v) => (v & 0x0f0f) === 0x0a0a;

function parseClientHello(buf) {
  if (buf[0] !== 0x16) return { error: 'not a TLS handshake record' };
  let p = 5;
  if (buf[p] !== 0x01) return { error: 'not a ClientHello' };
  p += 4;                                   // handshake type + 3-byte length
  const legacyVersion = buf.readUInt16BE(p); p += 2;
  p += 32;                                  // random
  const sidLen = buf[p]; p += 1 + sidLen;   // session id

  const csLen = buf.readUInt16BE(p); p += 2;
  const ciphers = [];
  for (let i = 0; i < csLen; i += 2) ciphers.push(buf.readUInt16BE(p + i));
  p += csLen;

  const compLen = buf[p]; p += 1 + compLen;

  const extTotal = buf.readUInt16BE(p); p += 2;
  const extEnd = p + extTotal;
  const extensions = [];
  let groups = [], formats = [], alpn = [], sigAlgs = [], versions = [], sni = null;

  while (p + 4 <= extEnd) {
    const type = buf.readUInt16BE(p);
    const len = buf.readUInt16BE(p + 2);
    const body = buf.slice(p + 4, p + 4 + len);
    extensions.push(type);
    if (type === 10) { const n = body.readUInt16BE(0); for (let i = 0; i < n; i += 2) groups.push(body.readUInt16BE(2 + i)); }
    if (type === 11) { const n = body[0]; for (let i = 0; i < n; i++) formats.push(body[1 + i]); }
    if (type === 13) { const n = body.readUInt16BE(0); for (let i = 0; i < n; i += 2) sigAlgs.push(body.readUInt16BE(2 + i)); }
    if (type === 43) { const n = body[0]; for (let i = 0; i < n; i += 2) versions.push(body.readUInt16BE(1 + i)); }
    if (type === 16) { let q = 2; while (q < body.length) { const l = body[q]; alpn.push(body.slice(q + 1, q + 1 + l).toString()); q += 1 + l; } }
    if (type === 0)  { try { sni = body.slice(5, 5 + body.readUInt16BE(3)).toString(); } catch {} }
    p += 4 + len;
  }

  const clean = (a) => a.filter((v) => !isGrease(v));
  const ja3 = [
    legacyVersion,
    clean(ciphers).join('-'),
    clean(extensions).join('-'),
    clean(groups).join('-'),
    formats.join('-'),
  ].join(',');

  // JA4: q/t + version + sni + counts + the first and last characters of alpn,
  //      _ hash(ciphers) _ hash(exts+sigalgs)
  const maxVer = clean(versions).length ? Math.max(...clean(versions)) : legacyVersion;
  const verMap = { 0x0304: '13', 0x0303: '12', 0x0302: '11', 0x0301: '10' };
  const cleanCiphers = clean(ciphers), cleanExts = clean(extensions);
  const h12 = (s) => (s ? crypto.createHash('sha256').update(s).digest('hex').slice(0, 12) : '000000000000');
  const sortedC = [...cleanCiphers].sort((a, b) => a - b).map((v) => v.toString(16).padStart(4, '0')).join(',');
  const sortedE = [...cleanExts].filter((t) => t !== 0 && t !== 16).sort((a, b) => a - b).map((v) => v.toString(16).padStart(4, '0')).join(',');
  const sigStr = clean(sigAlgs).map((v) => v.toString(16).padStart(4, '0')).join(',');
  const a = alpn[0] || '00';
  const ja4 = `t${verMap[maxVer] || '00'}${sni ? 'd' : 'i'}` +
    `${String(Math.min(cleanCiphers.length, 99)).padStart(2, '0')}` +
    `${String(Math.min(cleanExts.length, 99)).padStart(2, '0')}` +
    `${a[0]}${a[a.length - 1]}_${h12(sortedC)}_${h12(sigStr ? sortedE + '_' + sigStr : sortedE)}`;

  return {
    legacyVersion, sni, alpn,
    cipherCount: cleanCiphers.length,
    extCount: cleanExts.length,
    ciphers: cleanCiphers.map((v) => '0x' + v.toString(16).padStart(4, '0')),
    extensions: cleanExts,
    groups: clean(groups),
    formats, versions: clean(versions).map((v) => '0x' + v.toString(16)),
    hasGrease: ciphers.some(isGrease) || extensions.some(isGrease),
    ja3, ja3_md5: crypto.createHash('md5').update(ja3).digest('hex'), ja4,
  };
}

net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  const t = setTimeout(() => sock.destroy(), 3000);
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (buf.length < 5) return;
    const recLen = buf.readUInt16BE(3);
    if (buf.length < 5 + recLen) return;
    clearTimeout(t);
    const label = process.env.JA3_LABEL || 'unknown';
    const r = parseClientHello(buf.slice(0, 5 + recLen));
    fs.appendFileSync(OUT, JSON.stringify({ label, raw_bytes: 5 + recLen, ...r }) + '\n');
    console.log(`[${label}] ClientHello ${5 + recLen}B  JA3=${r.ja3_md5}  ALPN=${JSON.stringify(r.alpn)}`);
    sock.destroy();
  });
  sock.on('error', () => {});
}).listen(PORT, '127.0.0.1', () => console.log(`ja3 sink on ${PORT} -> ${OUT}`));
