/**
 * Choosing a locale from Accept-Language, and translating against it.
 *
 * The parsing has more edges than it looks: quality values reorder the list, `q=0` means
 * "explicitly not this one" rather than "last resort", and a header can be malformed by a
 * client we do not control. Getting any of them wrong picks the wrong language for an error
 * message, which nobody reports as a bug — they just read something they did not expect.
 *
 * Run: npm -w @agentlodge/server run test:i18n
 */
import { pickLocale, t } from './index.js';

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

const eq = (label: string, header: string | undefined, want: string): void =>
  ok(label, pickLocale(header) === want, `got ${pickLocale(header)}, want ${want}`);

console.log('\n=== Straightforward headers ===');
eq('a bare tag', 'ja', 'ja');
eq('tag with a region', 'zh-CN', 'zh');
eq('script and region', 'zh-Hans-CN', 'zh');
eq('Traditional Chinese uses the same table', 'zh-TW', 'zh');
eq('case is ignored', 'RU-ru', 'ru');
eq('English stays English', 'en-GB', 'en');

console.log('\n=== Nothing to go on means English ===');
eq('absent', undefined, 'en');
eq('empty', '', 'en');
eq('a language we do not have', 'de-DE', 'en');
eq('junk', ';;;,,,', 'en');
eq('*', '*', 'en');

console.log('\n=== Quality values ===');
eq('the first is taken when unweighted', 'ja,zh', 'ja');
eq('a higher q wins regardless of order', 'ja;q=0.2,zh;q=0.9', 'zh');
eq('unknown tags are skipped, not fatal', 'de;q=1.0,ru;q=0.4', 'ru');
eq('a missing q counts as 1', 'ru,ja;q=0.9', 'ru');
eq('q=0 means not this one, so the next wins', 'ja;q=0,zh;q=0.1', 'zh');
eq('q=0 on the only match falls back to English', 'ja;q=0', 'en');
eq('an unparseable q is treated as refusal, not as 1', 'ja;q=abc,zh', 'zh');
eq('whitespace around parts is tolerated', ' ja ; q=0.3 , zh ; q=0.8 ', 'zh');

console.log('\n=== Translating ===');
ok('English returns the source unchanged', t('en', 'No such user') === 'No such user');
ok('a known key is translated', t('zh', 'No such user') !== 'No such user');
ok(
  'an unknown key falls back to the source rather than leaking a key',
  t('zh', 'A string nobody has translated') === 'A string nobody has translated',
);
ok(
  'placeholders are filled',
  t('en', 'Memory cannot exceed {kb} KB', { kb: 64 }) === 'Memory cannot exceed 64 KB',
);
ok(
  'an unknown placeholder is left alone, not blanked',
  t('en', 'Hello {who} and {other}', { who: 'you' }) === 'Hello you and {other}',
);
ok(
  'placeholders survive translation',
  t('zh', 'Memory cannot exceed {kb} KB', { kb: 64 }).includes('64'),
);

console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
