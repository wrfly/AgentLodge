/**
 * The two price lists have to agree.
 *
 * One is `apps/web/src/lib/model-facts.ts`, which the model picker reads to tell somebody
 * what a model costs. The other is the seed in `apps/server/src/core/db/pricing.ts`, which
 * is what they are actually charged — and, since quota counts what a turn cost, what
 * decides when they are refused. A deployment where the picker says $1 and the bill says $5
 * is not a display bug.
 *
 * Nothing reconciles them at runtime: they are different packages, either side of the layer
 * boundary, and a price change lands in whichever file the person was looking at. So the
 * check is here. Only models present in both are compared; the seed carries the catch-all
 * and the facts carry models nobody has priced, and neither is an error.
 *
 * Run: node scripts/check-pricing.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

/**
 * model → {in, out, currency} from the picker's table.
 *
 * The currency matters as much as the number now that vendors are held at their own list:
 * a picker saying $1 beside a table charging ¥1 is wrong in a way neither figure reveals.
 */
const facts = new Map();
for (const m of read('apps/web/src/lib/model-facts.ts').matchAll(
  /'([\w.-]+)':\s*\{[^}]*?inPrice:\s*([\d.]+)[^}]*?outPrice:\s*([\d.]+)([^}]*)/g,
)) {
  const currency = /currency:\s*'([A-Z]{3})'/.exec(m[4] ?? '')?.[1] ?? 'USD';
  facts.set(m[1], { in: Number(m[2]), out: Number(m[3]), currency });
}

/**
 * model → {in, out, currency} from the seed's `rate(input, output)` calls.
 *
 * `currency` is optional and comes before the spread, which is why it is matched separately
 * rather than by widening the one pattern: a row that gained a field the pattern did not
 * expect used to stop matching altogether, and a parser that silently matches nothing passes
 * while checking nothing. The count assertion below is the backstop for exactly that.
 */
const seeded = new Map();
for (const m of read('apps/server/src/core/db/pricing.ts').matchAll(
  /\{ model: '([\w.*-]+)',\s*(currency: '([A-Z]{3})',\s*)?\.\.\.rate\(([\d.]+), ([\d.]+)/g,
)) {
  seeded.set(m[1], { in: Number(m[4]), out: Number(m[5]), currency: m[3] ?? 'USD' });
}

// A parser that quietly matched nothing would pass while checking nothing
if (facts.size < 8 || seeded.size < 8) {
  console.error(
    `✗ check-pricing read ${facts.size} models from model-facts.ts and ${seeded.size} from the `
      + 'seed, which cannot be right — one of the two files changed shape and this parser needs '
      + 'updating. Failing rather than reporting success on nothing.',
  );
  process.exit(1);
}

const problems = [];
let compared = 0;
for (const [model, a] of seeded) {
  const b = facts.get(model);
  if (!b) continue;
  compared += 1;
  const sym = (c) => (c === 'CNY' ? '¥' : c === 'USD' ? '$' : `${c} `);
  if (a.in !== b.in || a.out !== b.out || a.currency !== b.currency) {
    problems.push(
      `  ${model}: the seed bills ${sym(a.currency)}${a.in}/${sym(a.currency)}${a.out} per MTok, `
        + `the picker says ${sym(b.currency)}${b.in}/${sym(b.currency)}${b.out}`,
    );
  }
}

if (!compared) {
  console.error('✗ check-pricing compared no models at all — the two lists share no names');
  process.exit(1);
}

if (problems.length) {
  console.error(
    `✗ the price a user is shown and the price they are charged disagree:\n${problems.join('\n')}\n`
      + '  Quota counts what a turn cost, so this decides refusals as well as the bill.',
  );
  process.exit(1);
}

console.log(`✓ pricing agrees between the seed and the picker (${compared} models)`);
