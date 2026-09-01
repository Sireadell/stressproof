// Certificate tests.
//
// The promise here is "you do not have to trust us — check it yourself." That
// promise is only real if tampering is actually detected, so most of this file
// is deliberate tampering.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';

import {
  canonicalize,
  hashReport,
  signReport,
  verifyCertificate,
  getSignerAddress,
  _resetSignerCache,
} from '../src/lib/attestation.js';

// A fixed throwaway key so signatures are reproducible across runs. This key
// is public by definition and must never be used for anything real.
const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const signer = new Wallet(TEST_KEY);

const REPORT = Object.freeze({
  target: 'https://example.com/v1/agent',
  verdict: 'PARTIAL',
  score: 72,
  probesCompleted: 11,
  silentWrongCount: 1,
  probes: [
    { probe: 'malformed_json', outcome: 'CLEAN_REJECT' },
    { probe: 'injection_canary', outcome: 'SILENT_WRONG' },
  ],
});

beforeEach(() => _resetSignerCache());

test('canonical form does not depend on key order', () => {
  // If the same report can serialise two ways, verification fails at random
  // and starts calling honest reports forged. This is the load-bearing
  // property of the whole mechanism.
  const a = { b: 1, a: 2, c: { z: 1, y: 2 } };
  const b = { c: { y: 2, z: 1 }, a: 2, b: 1 };
  assert.equal(canonicalize(a), canonicalize(b));
});

test('canonical form preserves array order', () => {
  // A probe timeline means nothing if reordered — sorting it would destroy
  // the evidence ("failed at request 5 of 7") that the report exists to carry.
  assert.notEqual(canonicalize([1, 2, 3]), canonicalize([3, 2, 1]));
});

test('canonical form distinguishes values that look similar', () => {
  assert.notEqual(canonicalize({ a: 1 }), canonicalize({ a: '1' }));
  assert.notEqual(canonicalize({ a: null }), canonicalize({ a: 'null' }));
});

test('the same report always hashes the same', () => {
  assert.equal(hashReport(REPORT), hashReport(structuredClone(REPORT)));
});

test('a signed report verifies', async () => {
  const cert = await signReport(REPORT, { signer });
  assert.ok(cert, 'should have produced a certificate');
  const v = verifyCertificate(REPORT, cert);
  assert.equal(v.valid, true, v.reason);
  assert.equal(v.signer.toLowerCase(), signer.address.toLowerCase());
});

test('editing the verdict after signing is detected', async () => {
  // The attack this exists to stop: publishing a BRITTLE report, then quietly
  // changing it to RESILIENT.
  const cert = await signReport(REPORT, { signer });
  const tampered = { ...REPORT, verdict: 'RESILIENT' };
  const v = verifyCertificate(tampered, cert);
  assert.equal(v.valid, false);
  assert.match(v.reason, /altered/);
});

test('editing a single character of evidence is detected', async () => {
  const cert = await signReport(REPORT, { signer });
  const tampered = structuredClone(REPORT);
  tampered.probes[1].outcome = 'CLEAN_REJECT';
  const v = verifyCertificate(tampered, cert);
  assert.equal(v.valid, false);
  assert.match(v.reason, /altered/);
});

test('a certificate cannot be re-pointed at a different target', async () => {
  const cert = await signReport(REPORT, { signer });
  const v = verifyCertificate({ ...REPORT, target: 'https://other.example/agent' }, cert);
  assert.equal(v.valid, false);
});

test('a forged signature from another key is rejected', async () => {
  const cert = await signReport(REPORT, { signer });
  const impostor = Wallet.createRandom();
  const forged = { ...cert, signerAddress: impostor.address };
  const v = verifyCertificate(REPORT, forged);
  assert.equal(v.valid, false);
  assert.match(v.reason, /not produced by the address it claims/);
});

test('a mangled signature is rejected without crashing', async () => {
  const cert = await signReport(REPORT, { signer });
  const v = verifyCertificate(REPORT, { ...cert, signature: '0xdeadbeef' });
  assert.equal(v.valid, false);
  assert.match(v.reason, /could not be read/);
});

test('an incomplete certificate is rejected with a specific reason', async () => {
  const cert = await signReport(REPORT, { signer });
  const { signature, ...missingSig } = cert;
  const v = verifyCertificate(REPORT, missingSig);
  assert.equal(v.valid, false);
  assert.match(v.reason, /missing 'signature'/);
});

test('no certificate at all is rejected, not treated as valid', () => {
  assert.equal(verifyCertificate(REPORT, null).valid, false);
  assert.equal(verifyCertificate(REPORT, undefined).valid, false);
});

test('an unsigned deployment degrades to no certificate, never to a bad one', async () => {
  // A missing signing key must not fail an otherwise-good certification, and
  // must certainly not produce something that looks signed.
  const prev = process.env.STRESSPROOF_SIGNER_PRIVATE_KEY;
  delete process.env.STRESSPROOF_SIGNER_PRIVATE_KEY;
  _resetSignerCache();
  assert.equal(getSignerAddress(), null);
  assert.equal(await signReport(REPORT), null);
  if (prev !== undefined) process.env.STRESSPROOF_SIGNER_PRIVATE_KEY = prev;
  _resetSignerCache();
});
