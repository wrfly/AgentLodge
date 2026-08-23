/**
 * Grouping the model picker's list.
 *
 * The quiet failures: a family sorted the wrong way puts an old version at the top and it
 * becomes the one everybody picks; a dated snapshot ranked above its own alias does the same
 * thing in reverse; and a name that parses into nothing disappears from a list the user can
 * no longer reach any other way.
 *
 * Run: npm -w @agentlodge/server run test:protocol
 */
import { groupModels, type ModelLike } from './protocol.js';

let pass = 0;
let fail = 0;

function ok(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

const m = (id: string): ModelLike => ({ id, label: id });
const shape = (gs: Array<{ label: string; models: ModelLike[] }>): string =>
  gs.map((g) => `${g.label}:${g.models.map((x) => x.id).join(',')}`).join(' | ');

console.log('\n=== The list an official upstream returns ===');
{
  const groups = groupModels([
    'claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7',
    'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-opus-4-5-20251101',
    'claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929',
  ].map(m));

  ok('four families', groups.length === 4, shape(groups));
  ok('named without the shared vendor prefix', groups.map((g) => g.label).join(',') === 'opus,sonnet,fable,haiku', groups.map((g) => g.label).join(','));
  ok('in the order they were configured', groups[0]?.label === 'opus' && groups[1]?.label === 'sonnet');
  ok(
    'opus, newest first',
    groups[0]?.models.map((x) => x.id).join(',') === 'claude-opus-5,claude-opus-4-8,claude-opus-4-7,claude-opus-4-6,claude-opus-4-5-20251101',
    groups[0]?.models.map((x) => x.id).join(','),
  );
  ok('the newest of each family leads it', groups.map((g) => g.models[0]?.id).join(',') === 'claude-opus-5,claude-sonnet-5,claude-fable-5,claude-haiku-4-5-20251001');
  ok('nothing is dropped', groups.reduce((n, g) => n + g.models.length, 0) === 10);
}

console.log('\n=== Versions ===');
{
  const g = groupModels(['claude-opus-4-8', 'claude-opus-5', 'claude-opus-4-10'].map(m))[0]!;
  ok('4-10 is newer than 4-8 — compared as numbers, not text', g.models.map((x) => x.id).join(',') === 'claude-opus-5,claude-opus-4-10,claude-opus-4-8', g.models.map((x) => x.id).join(','));
}
{
  const g = groupModels(['claude-opus-4-5-20251101', 'claude-opus-4-5'].map(m))[0]!;
  ok(
    'the alias comes before its own dated snapshot',
    g.models.map((x) => x.id).join(',') === 'claude-opus-4-5,claude-opus-4-5-20251101',
    g.models.map((x) => x.id).join(','),
  );
}

console.log('\n=== Names that carry no version ===');
{
  const groups = groupModels(['deepseek-v4-flash', 'deepseek-v4-pro'].map(m));
  ok('each is a family of one', groups.length === 2 && groups.every((g) => g.models.length === 1), shape(groups));
  // Everything they share goes, including the version, because what is left is what tells
  // them apart. The rows still carry the full name; the label is only the heading.
  ok('the shared part goes, the distinguishing part stays', groups.map((g) => g.label).join(',') === 'flash,pro', groups.map((g) => g.label).join(','));
}
{
  const groups = groupModels(['deepseek-v4-pro', 'deepseek-v3-pro'].map(m));
  ok('a version they do not share is kept', groups.map((g) => g.label).join(',') === 'v4-pro,v3-pro', groups.map((g) => g.label).join(','));
}
{
  const groups = groupModels([m('gpt-5'), m('o3')]);
  ok('nothing in common means nothing is stripped', groups.map((g) => g.label).join(',') === 'gpt,o3', groups.map((g) => g.label).join(','));
}
{
  const groups = groupModels([m('claude-opus-5'), m('claude-opus-4-8')]);
  ok('a single family still loses the vendor prefix', groups[0]?.label === 'opus', String(groups[0]?.label));
}
{
  const groups = groupModels([m('4')]);
  ok('an all-numeric name is a family, not an empty one', groups[0]?.label === '4' && groups[0]?.models.length === 1, shape(groups));
}

console.log('\n=== The Default row ===');
{
  const groups = groupModels([{ id: '', label: 'Default' }, m('claude-opus-5')]);
  ok('it leads, ungrouped', groups[0]?.label === '' && groups[0]?.models[0]?.label === 'Default', shape(groups));
  ok('and the families follow', groups[1]?.label === 'opus');
}
{
  ok('an empty list groups into nothing', groupModels([]).length === 0);
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
