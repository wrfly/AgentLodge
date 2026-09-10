/**
 * Two checks the type system cannot make.
 *
 * 1. Nothing in the web app may bind `t` except the translator itself.
 *
 *    This is not style. `{TABS.map((t) => ... {t.label})}` type-checks, renders,
 *    and quietly shows English in every locale, because the loop variable
 *    shadowed the translator and `t.label` reads a field instead of calling it.
 *    That shipped once. A name collision that turns a translated string back
 *    into an untranslated one has to be caught mechanically.
 *
 * 2. Every `t('literal')` key must exist in every locale table.
 *
 *    A missing key falls back to English by design, which is the right runtime
 *    behaviour and a terrible review signal: nothing breaks, so nobody notices
 *    the locale is half done.
 *
 * 3. No locale table may keep a key the app no longer says.
 *
 *    Delete a screen and its translations stay behind, in eight files, forever.
 *    Nothing breaks — a key nobody looks up costs nothing at runtime — so the
 *    tables just grow, and the next person reading one cannot tell the live
 *    strings from the dead ones. 54 had accumulated before this check existed.
 *
 * Check 2 only sees literal keys: `t(someVariable)` cannot be resolved
 * statically. Check 3 is the reverse and has the opposite problem, so it asks a
 * weaker question — does this text appear *anywhere* in the app's sources? A key
 * reached through a variable still has to be written down somewhere, and that
 * somewhere is either the web app itself or one of the two server files listed
 * below that compose display text. A key found only inside a comment counts as
 * live, which is the safe way to be wrong: this check deletes translations.
 *
 * Run: npm run check:i18n
 */
import fs from 'node:fs';
import path from 'node:path';

const WEB = 'apps/web/src';
const SERVER = 'apps/server/src';
const LOCALES = ['zh', 'zh-Hant', 'ja', 'ru', 'de', 'fr', 'es', 'pt'];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

const files = walk(WEB).filter((f) => !f.includes(`${path.sep}locales${path.sep}`));
const problems = [];

/* ---- 1. shadowing ---- */
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  src.split('\n').forEach((line, i) => {
    // `(t)` or `(t,` as a parameter, `let/const/var t =` other than the translator
    const shadow =
      /(?:\(|,\s*)t\s*(?:\)|,|:)\s*=>/.test(line) ||
      /\b(?:const|let|var)\s+t\s*=(?!\s*useT\(\))/.test(line);
    if (shadow) {
      problems.push(
        `${file}:${i + 1}  binds \`t\`, which shadows the translator — rename it\n    ${line.trim()}`,
      );
    }
  });
}

/* ---- 2. key coverage ---- */
const used = new Set();
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/(?<![\w.])t\(\s*'((?:[^'\\]|\\.)*)'/g)) used.add(m[1]);
  for (const m of src.matchAll(/(?<![\w.])t\(\s*"((?:[^"\\]|\\.)*)"/g)) used.add(m[1]);
}
// The doc comment in lib/i18n.ts uses this as an example of what not to do
used.delete('apiKeys.revoke');

/*
 * The System settings page renders `t(s.label)` and `t(s.hint)` — a variable, so the scan
 * above cannot see either one. That is the blind spot named at the top of this file, and it
 * had swallowed every setting on the page: each one showed English in every locale and
 * nothing complained. The literals live in one array, so they can be read from there.
 */
const specSrc = fs.readFileSync(`${SERVER}/core/db/settings.ts`, 'utf8');
for (const m of specSrc.matchAll(/\b(?:label|hint): '((?:[^'\\]|\\.)*)'/g)) used.add(m[1]);

for (const loc of LOCALES) {
  const src = fs.readFileSync(`${WEB}/locales/${loc}.ts`, 'utf8');
  const have = new Set(
    [...src.matchAll(/^ {2}(?:'((?:[^'\\]|\\.)*)'|([A-Za-z_$][A-Za-z0-9_$]*)): /gm)].map(
      (m) => m[1] ?? m[2],
    ),
  );
  const missing = [...used].filter((k) => !have.has(k));
  if (missing.length) {
    problems.push(
      `locales/${loc}.ts is missing ${missing.length} key(s):\n` +
        missing.map((k) => `    ${k.length > 70 ? `${k.slice(0, 70)}…` : k}`).join('\n'),
    );
  }
}

/* ---- 3. keys the app no longer says ---- */
/*
 * The two server files that compose text the web renders through `t()`: the settings spec's
 * labels and hints, and `resolveRange`'s range labels. Anything else the server sends and the
 * web translates has to be added here, or its keys will read as dead.
 */
const COMPOSED_BY_SERVER = [`${SERVER}/core/db/settings.ts`, `${SERVER}/app/routes/me.ts`];
const haystack = [...files, ...COMPOSED_BY_SERVER]
  .map((f) => fs.readFileSync(f, 'utf8'))
  .join('\n');
// A key with an apostrophe is written `\'` in a single-quoted literal
const saidSomewhere = (key) =>
  haystack.includes(key) || haystack.includes(key.replace(/'/g, "\\'"));

for (const loc of LOCALES) {
  const src = fs.readFileSync(`${WEB}/locales/${loc}.ts`, 'utf8');
  const dead = [...src.matchAll(/^ {2}'((?:[^'\\]|\\.)*)': /gm)]
    .map((m) => m[1].replace(/\\'/g, "'"))
    .filter((k) => !saidSomewhere(k));
  if (dead.length) {
    problems.push(
      `locales/${loc}.ts keeps ${dead.length} key(s) the app no longer says:\n` +
        dead.map((k) => `    ${k.length > 70 ? `${k.slice(0, 70)}…` : k}`).join('\n'),
    );
  }
}

/* ---- 4. the server's own tables ---- */
// The server translates the messages it sends, keyed the same way (core/i18n). Its keys are
// literals in `tr(req, '…')`, so the same coverage check applies — and matters as much: an
// untranslated error is the one piece of text a user sees at their worst moment.
const serverUsed = new Set();
for (const file of walk(SERVER).filter((f) => !f.includes(`${path.sep}i18n${path.sep}`))) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/tr\(\s*req,\s*'((?:[^'\\]|\\.)*)'/g)) serverUsed.add(m[1]);
  for (const m of src.matchAll(/tr\(\s*req,\s*"((?:[^"\\]|\\.)*)"/g)) serverUsed.add(m[1]);
}

const serverHaystack = walk(SERVER)
  .filter((f) => !f.includes(`${path.sep}i18n${path.sep}`))
  .map((f) => fs.readFileSync(f, 'utf8'))
  .join('\n');
const serverSaid = (key) =>
  serverHaystack.includes(key) || serverHaystack.includes(key.replace(/'/g, "\\'"));

for (const loc of LOCALES) {
  const src = fs.readFileSync(`${SERVER}/core/i18n/${loc}.ts`, 'utf8');
  const have = new Set(
    [...src.matchAll(/^ {2}'((?:[^'\\]|\\.)*)': /gm)].map((m) => m[1]),
  );
  const missing = [...serverUsed].filter((k) => !have.has(k));
  if (missing.length) {
    problems.push(
      `core/i18n/${loc}.ts is missing ${missing.length} key(s):\n` +
        missing.map((k) => `    ${k.length > 70 ? `${k.slice(0, 70)}…` : k}`).join('\n'),
    );
  }
  /*
   * The same weaker question as the web, not `!serverUsed.has(k)`. `validatePassword`
   * returns an English source string and its caller does `tr(req, thatString)`, so three
   * live password messages read as dead under an exact check.
   */
  const dead = [...have].filter((k) => !serverSaid(k));
  if (dead.length) {
    problems.push(
      `core/i18n/${loc}.ts keeps ${dead.length} key(s) no \`tr\` asks for:\n` +
        dead.map((k) => `    ${k.length > 70 ? `${k.slice(0, 70)}…` : k}`).join('\n'),
    );
  }
}

if (problems.length) {
  console.error(`✗ i18n check failed\n\n${problems.join('\n\n')}\n`);
  process.exit(1);
}
console.log(
  `✓ i18n OK — web ${used.size} keys (settings labels included), server ${serverUsed.size} keys, `
    + `${LOCALES.length} locales fully covered, nothing dead, no \`t\` shadowing`,
);
