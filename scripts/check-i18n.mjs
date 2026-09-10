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
 *    strings from the dead ones. 38 had accumulated before this check existed —
 *    36 in the web tables and 2 in the server's.
 *
 * Check 2 only sees literal keys: `t(someVariable)` cannot be resolved
 * statically, and 22 call sites pass a variable. Check 3 is the reverse and has
 * the opposite problem — an exact "no `t('…')` names this" would condemn every
 * key those 22 reach. So it asks a much weaker question: does this text appear
 * *anywhere* in either app's sources?
 *
 * Deliberately no list of "files that supply display text". The first version of
 * this check had one, with two entries and a comment asking the next person to
 * extend it. It was already wrong when it was written — provider kind labels
 * (core/db/providers.ts) and model hints (app/agents/*.ts) are both handed to the
 * web and translated there — and it deleted eight working translations. A check
 * whose output is a delete script must not depend on a list somebody remembers to
 * update. Every source file of both apps is searched instead.
 *
 * That makes it lenient: a key found only inside a comment counts as live, and so
 * does one that happens to be a substring of another string. Both are the safe
 * way to be wrong. This check deletes translations; it should miss a dead key
 * rather than invent one.
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
      /(?:\(|,\s*)t\s*(?::[^,)]*)?\s*(?:\)|,)\s*=>/.test(line) ||
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
 * A long string is often written across lines with `+`, so the literal never appears whole
 * anywhere. Splicing the joins back together is what lets those be searched for at all —
 * `settings.ts` builds one hint out of three pieces.
 */
const spliced = (text) => text.replace(/'\s*\+\s*'/g, '').replace(/"\s*\+\s*"/g, '');
const readAll = (list) => spliced(list.map((f) => fs.readFileSync(f, 'utf8')).join('\n'));

const serverFiles = walk(SERVER).filter((f) => !f.includes(`${path.sep}i18n${path.sep}`));
// Both apps, whole. See the note on lists at the top of this file.
const haystack = readAll([...files, ...serverFiles]);
const serverHaystack = readAll(serverFiles);
// A key with an apostrophe is written `\'` in a single-quoted literal
const saidIn = (hay, key) => hay.includes(key) || hay.includes(key.replace(/'/g, "\\'"));

// Both spellings a table uses — quoted, and the bare identifier a plain word gets
const KEY_LINE = /^ {2}(?:'((?:[^'\\]|\\.)*)'|([A-Za-z_$][A-Za-z0-9_$]*)): /gm;

for (const loc of LOCALES) {
  const src = fs.readFileSync(`${WEB}/locales/${loc}.ts`, 'utf8');
  const dead = [...src.matchAll(KEY_LINE)]
    .map((m) => (m[1] ?? m[2]).replace(/\\'/g, "'"))
    .filter((k) => !saidIn(haystack, k));
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
  const dead = [...have].filter((k) => !saidIn(serverHaystack, k));
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
