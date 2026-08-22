#!/usr/bin/env node
/**
 * The trace viewer.
 *
 *   node view.js                 list every request captured
 *   node view.js 3               expand request #3 (conversation, tools, usage)
 *   node view.js 3 --raw         print the raw request/response JSON
 *   node view.js 3 --events      print the SSE events one by one
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TRACE_DIR = process.env.TRACE_DIR || path.join(__dirname, 'traces');
const INDEX = path.join(TRACE_DIR, 'index.jsonl');

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  mag: (s) => `\x1b[35m${s}\x1b[0m`,
};

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
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

function list() {
  const rows = readIndex();
  if (!rows.length) return console.log(c.dim('(nothing captured yet)'));
  console.log(c.bold('\n  #   status  ms      path                              model                     usage'));
  console.log(c.dim('  ' + '─'.repeat(104)));
  for (const r of rows) {
    const u = r.usage
      ? `in=${r.usage.input_tokens ?? r.usage.prompt_tokens ?? '-'} out=${
          r.usage.output_tokens ?? r.usage.completion_tokens ?? '-'
        } cr=${r.usage.cache_read_input_tokens ?? 0}`
      : '';
    const st = r.error ? c.red('ERR') : r.status < 400 ? c.green(String(r.status)) : c.red(String(r.status));
    console.log(
      `  ${String(r.id).padEnd(4)}${st.padEnd(15)}${String(r.duration_ms ?? '').padEnd(8)}${(r.path || '').padEnd(34)}${(
        r.model || '-'
      ).padEnd(26)}${c.dim(u)}`
    );
  }
  console.log(c.dim(`\n  ${rows.length} records · expand one with: node view.js <#>\n`));
}

function show(id, opts) {
  const rows = readIndex();
  const r = rows.find((x) => x.id === id);
  if (!r) return console.log(c.red(`no #${id} here`));
  const dir = r.dir;

  const req = loadJSON(dir, 'request.json');
  const body = loadJSON(dir, 'request.body.json');
  const sum = loadJSON(dir, 'request.summary.json');
  const resH = loadJSON(dir, 'response.headers.json');
  const rec = loadJSON(dir, 'response.reconstructed.json');
  const resB = loadJSON(dir, 'response.body.json');

  if (opts.raw) {
    console.log(c.bold('\n── request.body.json ──'));
    console.log(JSON.stringify(body, null, 2));
    console.log(c.bold('\n── response ──'));
    console.log(JSON.stringify(resB || rec, null, 2));
    return;
  }

  if (opts.events) {
    const f = path.join(TRACE_DIR, dir, 'response.stream.jsonl');
    if (!fs.existsSync(f)) return console.log(c.dim('this one was not a streamed response'));
    for (const line of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
      const e = JSON.parse(line);
      console.log(`${c.mag((e.event || '?').padEnd(30))} ${JSON.stringify(e.data).slice(0, 200)}`);
    }
    return;
  }

  console.log(c.bold(`\n═══ #${id}  ${req.method} ${req.url}  → ${req.upstream}`));
  console.log(
    c.dim(`    ${req.time}  ·  ${r.duration_ms}ms  ·  status ${r.status}`) +
    c.dim(r.upstream_http_version ? `  ·  ${r.upstream_http_version}` : '') +
    c.dim(r.content_encoding ? `  ·  ${r.content_encoding}` : '') + '\n'
  );

  console.log(c.bold('── Request headers'));
  for (const [k, v] of Object.entries(req.headers)) console.log(`   ${c.cyan(k)}: ${v}`);

  if (sum) {
    console.log(c.bold('\n── Request parameters'));
    console.log(
      `   model=${sum.model}  stream=${sum.stream}  max_tokens=${sum.max_tokens}  cache_breakpoints=${sum.cache_breakpoints}`
    );
    if (sum.thinking) console.log(`   thinking=${JSON.stringify(sum.thinking)}`);
    if (sum.metadata) console.log(`   metadata=${JSON.stringify(sum.metadata)}`);

    if (sum.system) {
      console.log(c.bold('\n── system'));
      const blocks = Array.isArray(sum.system) ? sum.system : [sum.system];
      blocks.forEach((b, i) =>
        console.log(`   [${i}] ${b.chars} chars ${b.cache_control ? c.yellow('CACHE') : ''}\n       ${c.dim(b.text)}`)
      );
    }

    if (sum.tools) {
      console.log(c.bold(`\n── tools (${sum.tool_count})`));
      for (const t of sum.tools)
        console.log(`   ${c.green(t.name)} ${c.dim(`desc=${t.desc_chars}c schema=${t.schema_chars}c`)}${t.cache_control ? c.yellow(' CACHE') : ''}`);
    }

    if (sum.messages) {
      console.log(c.bold(`\n── messages (${sum.message_count})`));
      for (const m of sum.messages) {
        console.log(`   ${c.cyan(`[${m.i}] ${m.role}`)}`);
        if (m.text) console.log(`       ${c.dim(m.text)}`);
        for (const b of m.blocks || []) {
          const tag = b.type.padEnd(18);
          if (b.name) console.log(`       ${c.mag(tag)} ${b.name} ${c.dim(b.input || '')}`);
          else if (b.tool_use_id) console.log(`       ${c.mag(tag)} ${b.tool_use_id} ${c.dim(b.content || '')}`);
          else console.log(`       ${c.mag(tag)} ${c.dim(b.text ?? JSON.stringify(b))}`);
        }
      }
    }
  }

  console.log(c.bold('\n── Response headers'));
  for (const [k, v] of Object.entries(resH?.headers || {})) console.log(`   ${c.cyan(k)}: ${v}`);

  if (resH?.quota) {
    console.log(c.bold('\n── Allowance / rate limits (response headers)'));
    for (const [k, v] of Object.entries(resH.quota)) console.log(`   ${c.yellow(k)}: ${v}`);
  }
  if (rec?.rate_limits) {
    console.log(c.bold('\n── Allowance (sent inside the SSE stream)'));
    console.log('   ' + JSON.stringify(rec.rate_limits, null, 2).split('\n').join('\n   '));
  }

  if (rec) {
    console.log(c.bold('\n── Response (reconstructed from SSE)'));
    console.log(`   model=${rec.model} stop_reason=${rec.stop_reason} events=${rec.event_count}`);
    console.log(`   usage=${JSON.stringify(rec.usage)}`);
    if (rec.thinking) console.log(`\n   ${c.dim('[thinking] ' + rec.thinking.slice(0, 800))}`);
    if (rec.text) console.log(`\n   ${rec.text.slice(0, 2000)}`);
    for (const t of rec.tool_uses || [])
      console.log(`\n   ${c.mag('tool_use')} ${c.green(t.name)} ${JSON.stringify(t.parsed ?? t.input).slice(0, 800)}`);
  } else if (resB) {
    console.log(c.bold('\n── Response body'));
    console.log(JSON.stringify(resB, null, 2).slice(0, 4000));
  }
  console.log('');
}

const args = process.argv.slice(2);
const opts = { raw: args.includes('--raw'), events: args.includes('--events') };
const id = args.find((a) => /^\d+$/.test(a));
if (id) show(Number(id), opts);
else list();
