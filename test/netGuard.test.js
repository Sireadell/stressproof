// Network guard tests.
//
// Every case here is a real technique for making a server fetch something it
// should not. If any of these regress, StressProof becomes a way to reach
// private systems from the outside, so these tests matter more than the
// feature tests do.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkAddress,
  checkUrlShape,
  resolveAndCheckHost,
  checkTarget,
} from '../src/lib/netGuard.js';

test('ordinary public addresses are allowed', () => {
  assert.equal(checkAddress('8.8.8.8').ok, true);
  assert.equal(checkAddress('1.1.1.1').ok, true);
  assert.equal(checkAddress('2606:4700::1111').ok, true);
});

test('loopback is refused', () => {
  assert.equal(checkAddress('127.0.0.1').ok, false);
  assert.equal(checkAddress('127.99.1.5').ok, false);
  assert.equal(checkAddress('::1').ok, false);
});

test('private ranges are refused', () => {
  for (const a of ['10.0.0.1', '192.168.1.1', '172.16.5.4', '172.31.255.254']) {
    assert.equal(checkAddress(a).ok, false, `${a} must be refused`);
  }
});

test('cloud credential endpoint is refused', () => {
  // 169.254.169.254 serves cloud instance credentials on AWS/GCP/Azure. A
  // server tricked into fetching it can leak the keys to its own infra.
  const v = checkAddress('169.254.169.254');
  assert.equal(v.ok, false);
  assert.match(v.reason, /link-local/i);
});

test('IPv4-mapped IPv6 loopback is refused', () => {
  // The classic bypass: reads as IPv6, connects to IPv4 127.0.0.1.
  const v = checkAddress('::ffff:127.0.0.1');
  assert.equal(v.ok, false);
  assert.match(v.reason, /127\.0\.0\.1/);
});

test('IPv4-mapped IPv6 public address is still allowed', () => {
  // The unwrapping must not become a blanket ban on mapped addresses.
  assert.equal(checkAddress('::ffff:8.8.8.8').ok, true);
});

test('private and unusual IPv6 ranges are refused', () => {
  assert.equal(checkAddress('fc00::1').ok, false, 'unique-local');
  assert.equal(checkAddress('fe80::1').ok, false, 'link-local');
});

test('unspecified and reserved addresses are refused', () => {
  assert.equal(checkAddress('0.0.0.0').ok, false);
  assert.equal(checkAddress('255.255.255.255').ok, false);
});

test('garbage is refused rather than crashing', () => {
  assert.equal(checkAddress('not-an-ip').ok, false);
  assert.equal(checkAddress('').ok, false);
  assert.equal(checkAddress('999.999.999.999').ok, false);
});

test('only https targets are accepted', () => {
  // Over plain http the consent proof is readable and alterable in transit,
  // which would make the whole permission check meaningless.
  assert.equal(checkUrlShape('https://example.com/agent').ok, true);
  assert.equal(checkUrlShape('http://example.com/agent').ok, false);
  assert.equal(checkUrlShape('file:///etc/passwd').ok, false);
  assert.equal(checkUrlShape('ftp://example.com').ok, false);
});

test('credentials embedded in the URL are refused', () => {
  // https://real-looking-site.com@evil.example/ actually contacts evil.example.
  assert.equal(checkUrlShape('https://user:pass@example.com/').ok, false);
  assert.equal(checkUrlShape('https://real.com@evil.example/').ok, false);
});

test('malformed URLs are refused', () => {
  assert.equal(checkUrlShape('not a url').ok, false);
  assert.equal(checkUrlShape('').ok, false);
});

test('a hostname given as a private IP literal is refused', async () => {
  const v = await resolveAndCheckHost('127.0.0.1');
  assert.equal(v.ok, false);
});

test('decimal and octal IP literals cannot smuggle loopback through', async () => {
  // 2130706433 and 0177.0.0.1 are both 127.0.0.1 written unusually. Node's
  // URL parser normalises them before the guard sees them, so the guard sees
  // the real destination.
  for (const raw of ['https://2130706433/', 'https://0177.0.0.1/']) {
    const v = await checkTarget(raw);
    assert.equal(v.ok, false, `${raw} must not be reachable`);
  }
});

test('a public hostname passes the full check', async () => {
  const v = await checkTarget('https://example.com/');
  assert.equal(v.ok, true, v.reason);
  assert.ok(Array.isArray(v.addresses) && v.addresses.length > 0);
});

test('localhost is refused end to end', async () => {
  const v = await checkTarget('https://localhost:8080/agent');
  assert.equal(v.ok, false);
});

test('the test-mode bypass is off unless explicitly passed', async () => {
  // The bypass is a function argument, never an environment variable, so no
  // deployment mistake can switch the guard off in production. The route
  // layer never passes it.
  const guarded = await checkTarget('http://127.0.0.1:9999/agent');
  assert.equal(guarded.ok, false, 'must be refused by default');

  const bypassed = await checkTarget('http://127.0.0.1:9999/agent', {
    allowPrivateAddresses: true,
  });
  assert.equal(bypassed.ok, true);
  assert.equal(bypassed.testModeBypass, true, 'bypass must be visibly flagged in the result');
});
