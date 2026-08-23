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
 * Only literal keys are checked. `t(someVariable)` — a label handed over by the
 * server, say — cannot be resolved statically; those are the ones to look at by
 * hand when adding a source of display text.
 *
 * Run: npm run check:i18n
 */
import fs from 'node:fs';
import path from 'node:path';

const WEB = 'apps/web/src';
const SERVER = 'apps/server/src';
const LOCALES = ['zh', 'ja', 'ru'];

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

/* ---- 3. the server's own tables ---- */
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
}

if (problems.length) {
  console.error(`✗ i18n check failed\n\n${problems.join('\n\n')}\n`);
  process.exit(1);
}
console.log(
  `✓ i18n OK — web ${used.size} keys (settings labels included), server ${serverUsed.size} keys, `
    + `${LOCALES.length} locales fully covered, no \`t\` shadowing`,
);
