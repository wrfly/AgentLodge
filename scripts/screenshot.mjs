/**
 * The project page's screenshots, at the resolution they are stored in.
 *
 * They go stale every time the interface changes, and taking them by hand means a
 * different window size and a different scroll position every time. This drives a headless
 * Chrome over the DevTools protocol instead: a 1280×631 viewport at device scale 2, which
 * is the 2560×1262 the files in site/ have.
 *
 * The application keeps its access token in memory only, so the way in is the refresh
 * cookie — fetched from the login endpoint and set through CDP before the first
 * navigation, exactly as a browser would have it.
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=… node scripts/screenshot.mjs
 *   BASE=http://localhost:8080 node scripts/screenshot.mjs site/shot-chat.png claude
 *
 * With no arguments it retakes every shot the page uses.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:8080';
const EMAIL = process.env.ADMIN_EMAIL ?? 'admin@a.com';
const PASSWORD = process.env.ADMIN_PASSWORD;
const CHROME = process.env.CHROME ?? '/opt/google/chrome/chrome';
const PORT = Number(process.env.CDP_PORT ?? 9333);

/** The scroll container the console and the chat both use */
const SCROLLER = "document.querySelector('div.h-full.overflow-y-auto')";
/** Put a card at the top of the view, by the text it starts with */
const cardAtTop = (title) =>
  `(()=>{const sc=${SCROLLER};const card=[...sc.querySelectorAll('div')]`
  + `.find(e=>e.textContent.trim().startsWith(${JSON.stringify(title)}));`
  + `sc.scrollTop=card.getBoundingClientRect().top-sc.getBoundingClientRect().top+sc.scrollTop-16;return sc.scrollTop})()`;
/** The chat's own scroller, which is the tallest thing on the page */
const toBottom =
  "(()=>{const e=[...document.querySelectorAll('div')].filter(d=>d.scrollHeight>d.clientHeight+50)"
  + ".sort((a,b)=>b.scrollHeight-a.scrollHeight)[0];e&&e.scrollTo({top:e.scrollHeight});return e&&e.scrollHeight})()";
const openConversation = (title) =>
  `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(title)})?.click()`;

/** What the project page shows. Each entry is a path, a route, and what to do before the shot. */
const SHOTS = [
  { out: 'site/shot-chat.png', route: 'claude', steps: [openConversation('System status check'), toBottom] },
  { out: 'site/shot-credentials.png', route: 'admin/settings', steps: ['document.title', cardAtTop('Upstream credentials')] },
  { out: 'site/shot-usage.png', route: 'usage', steps: [] },
  { out: 'site/shot-memory.png', route: 'memory', steps: [] },
  { out: 'site/shot-admin.png', route: 'admin/overview', steps: [] },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function refreshCookie() {
  if (!PASSWORD) throw new Error('set ADMIN_PASSWORD (and ADMIN_EMAIL if it is not admin@a.com)');
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  const cookie = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith('agentlodge_rt='));
  if (!cookie) throw new Error('the login response carried no refresh cookie');
  return cookie.slice('agentlodge_rt='.length);
}

async function connect() {
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=/tmp/agentlodge-shot-${process.pid}`,
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: 'ignore' });

  let target;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250);
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      target = list.find((t) => t.type === 'page');
    } catch { /* not up yet */ }
  }
  if (!target) throw new Error(`${CHROME} did not come up — set CHROME to the binary`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));

  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    const waiting = msg.id && pending.get(msg.id);
    if (!waiting) return;
    pending.delete(msg.id);
    msg.error ? waiting.reject(new Error(msg.error.message)) : waiting.resolve(msg.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  return { send, close: () => { ws.close(); chrome.kill(); } };
}

const refresh = await refreshCookie();
const { send, close } = await connect();

await send('Network.enable');
await send('Network.setCookie', { name: 'agentlodge_rt', value: refresh, domain: 'localhost', path: '/' });
await send('Page.enable');
// The window includes the browser's own chrome, so the viewport is set explicitly
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 631, deviceScaleFactor: 2, mobile: false });

const [outArg, routeArg, ...stepArgs] = process.argv.slice(2);
const shots = outArg ? [{ out: outArg, route: routeArg ?? 'claude', steps: stepArgs }] : SHOTS;

for (const shot of shots) {
  await send('Page.navigate', { url: `${BASE}/${shot.route}` });
  await sleep(6000);
  for (const step of shot.steps) {
    await send('Runtime.evaluate', { expression: step, awaitPromise: true });
    await sleep(2500);
  }
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  await fs.mkdir(path.dirname(shot.out), { recursive: true });
  await fs.writeFile(shot.out, Buffer.from(data, 'base64'));
  console.log(`  ${shot.out}`);
}

close();
