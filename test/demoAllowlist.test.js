import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDemoAllowlist, parseAllowlistFile, isUsableEntry, DEFAULT_ALLOWLIST_FILE } from '../src/lib/demoAllowlist.js';

const fileWith = (text) => () => text;
const noFile = () => {
  throw new Error('ENOENT');
};

test('env var alone behaves as before', () => {
  const { allowlist } = loadDemoAllowlist({ env: { STRESSPROOF_DEMO_ALLOWLIST: 'https://a.example, https://b.example' }, readFile: noFile });
  assert.deepEqual(allowlist, ['https://a.example', 'https://b.example']);
});

test('file entries are added, comments and blanks skipped', () => {
  const text = '# note\n\nhttps://c.example\r\n  https://d.example/api  \n';
  assert.deepEqual(parseAllowlistFile(text), ['https://c.example', 'https://d.example/api']);
  const { allowlist } = loadDemoAllowlist({ env: { STRESSPROOF_DEMO_ALLOWLIST: 'https://a.example' }, readFile: fileWith(text) });
  assert.deepEqual(allowlist, ['https://a.example', 'https://c.example', 'https://d.example/api']);
});

test('duplicates across env and file appear once', () => {
  const { allowlist } = loadDemoAllowlist({ env: { STRESSPROOF_DEMO_ALLOWLIST: 'https://a.example' }, readFile: fileWith('https://a.example\n') });
  assert.deepEqual(allowlist, ['https://a.example']);
});

test('an entry with no host is refused, so it cannot match every target', () => {
  for (const bad of ['https://', 'http://', 'not a url', 'ftp://x.example']) assert.equal(isUsableEntry(bad), false, bad);
  const { allowlist, rejected } = loadDemoAllowlist({ env: {}, readFile: fileWith('https://\nhttps://ok.example\n') });
  assert.deepEqual(allowlist, ['https://ok.example']);
  assert.deepEqual(rejected, ['https://']);
});

test('the shipped file parses and lists Ward', () => {
  const { allowlist, rejected } = loadDemoAllowlist({ env: {}, filePath: DEFAULT_ALLOWLIST_FILE });
  assert.deepEqual(rejected, []);
  assert.ok(allowlist.includes('https://suture-47gy.onrender.com'));
});
