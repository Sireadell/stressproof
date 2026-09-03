// Tests for the self-contained certificate link.
//
// The whole claim being tested is "this URL verifies with no help from the
// server". So the tests here never start a server and never store anything:
// they encode, decode, and check that what came back is byte-identical to what
// went in, and that a link a stranger tampered with is caught by the signature
// rather than by anything we remembered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { Wallet } from 'ethers';

import {
  encodeCertificateLink,
  decodeCertificateLink,
  LINK_PREFIX,
  MAX_TOKEN_CHARS,
} from '../src/lib/certificateLink.js';
import { signReport, verifyCertificate } from '../src/lib/attestation.js';

/** A report shaped like a real one, big enough to be a fair size test. */
function sampleReport(overrides = {}) {
  return {
    target: 'https://agent.example.com/api',
    specVersion: 'sp-test-1',
    verdict: 'PARTIAL',
    verdictReason: 'one silent failure caps the verdict',
    score: 83,
    probesCompleted: 7,
    probesScorable: 10,
    completedFamilies: ['input_validation', 'load'],
    probesRunSummary: 'All 12 probes ran.',
    silentWrongCount: 1,
    unclassifiedCount: 4,
    notApplicable: 1,
    requestsUsed: 26,
    maxRequests: 30,
    durationMs: 2411,
    probes: Array.from({ length: 12 }, (_, i) => ({
      probe: `probe_${i}`,
      outcome: 'GRACEFUL',
      reason: 'answered with a clear error, which is the honest outcome',
      points: 10,
      requestsUsed: 2,
      findings: { status: 400, echoed: false, bodyBytes: 214 },
      skipped: null,
    })),
    ...overrides,
  };
}

const signer = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

test('a real-sized report and certificate fit inside a link', async () => {
  const report = sampleReport();
  const certificate = await signReport(report, { signer });
  const link = encodeCertificateLink({ report, certificate });

  assert.equal(link.ok, true, link.reason);
  assert.ok(link.token.startsWith(LINK_PREFIX));
  assert.ok(
    link.token.length < MAX_TOKEN_CHARS,
    `token was ${link.token.length} chars, which is over the ceiling we promise to stay under`,
  );
  assert.equal(link.path, `/c/${link.token}`);
});

test('a decoded link is the same report that went in, exactly', async () => {
  const report = sampleReport();
  const certificate = await signReport(report, { signer });
  const { token } = encodeCertificateLink({ report, certificate });

  const back = decodeCertificateLink(token);
  assert.equal(back.ok, true, back.reason);
  // Byte-for-byte, not merely similar. A round trip that reorders or drops a
  // field would break the report hash, which is exactly the failure that would
  // make a genuine certificate look forged.
  assert.deepEqual(back.report, report);
  assert.deepEqual(back.certificate, certificate);
});

test('a link survives verification with no stored state whatsoever', async () => {
  const report = sampleReport();
  const certificate = await signReport(report, { signer });
  const { token } = encodeCertificateLink({ report, certificate });

  const back = decodeCertificateLink(token);
  const result = verifyCertificate(back.report, back.certificate);
  assert.equal(result.valid, true, result.reason);
  assert.equal(result.signer.toLowerCase(), signer.address.toLowerCase());
});

test('a link whose verdict was edited fails verification', async () => {
  const report = sampleReport();
  const certificate = await signReport(report, { signer });

  // Forge the link the only way a holder actually can: re-encode a changed
  // report against the untouched certificate. The certificate says RESILIENT
  // is not what was signed, and the report hash is what proves it.
  const tampered = { ...report, verdict: 'RESILIENT', score: 100 };
  const { token } = encodeCertificateLink({ report: tampered, certificate });

  const back = decodeCertificateLink(token);
  assert.equal(back.ok, true);
  const result = verifyCertificate(back.report, back.certificate);
  assert.equal(result.valid, false);
  assert.match(result.reason, /altered since signing/);
});

test('an unsigned report still gets a link, and the link says it is unsigned', () => {
  const link = encodeCertificateLink({ report: sampleReport(), certificate: null });
  assert.equal(link.ok, true, link.reason);
  const back = decodeCertificateLink(link.token);
  assert.equal(back.ok, true);
  assert.equal(back.certificate, null);
});

test('a report too large to carry is refused at issue time rather than published', () => {
  // A link we know is over the ceiling must never be handed out. It would look
  // fine until it hit a proxy with a smaller request-line limit, and would then
  // fail in a way indistinguishable from the 404 this feature exists to remove.
  const huge = sampleReport({
    probes: Array.from({ length: 400 }, (_, i) => ({
      probe: `probe_${i}`,
      outcome: 'GRACEFUL',
      // Random text so it cannot be compressed away, which is what makes this
      // a genuine size test rather than a test of brotli.
      reason: [...Array(40)].map(() => Math.random().toString(36).slice(2)).join(' '),
      findings: { blob: Math.random().toString(36).repeat(20) },
    })),
  });

  const link = encodeCertificateLink({ report: huge, certificate: null });
  assert.equal(link.ok, false);
  assert.match(link.reason, /past the \d+-character ceiling/);
  assert.match(link.reason, /POSTing the report and certificate to \/verify/);
});

test('a link with no report at all is refused', () => {
  assert.equal(encodeCertificateLink({ report: null, certificate: null }).ok, false);
});

test('junk in the link position is refused with a reason, not a crash', () => {
  const cases = [
    ['', /no certificate token/],
    [null, /no certificate token/],
    ['hello', /not a StressProof certificate link/],
    [`${LINK_PREFIX}not base64!!`, /characters that are not part of one/],
    [`${LINK_PREFIX}aGVsbG8`, /damaged or incomplete/],
  ];
  for (const [input, expected] of cases) {
    const out = decodeCertificateLink(input);
    assert.equal(out.ok, false, `expected '${input}' to be refused`);
    assert.match(out.reason, expected);
  }
});

test('a truncated link is refused rather than half-read', async () => {
  const report = sampleReport();
  const certificate = await signReport(report, { signer });
  const { token } = encodeCertificateLink({ report, certificate });

  const out = decodeCertificateLink(token.slice(0, token.length - 40));
  assert.equal(out.ok, false);
  assert.match(out.reason, /damaged or incomplete/);
});

test('valid brotli that decodes to something other than a report is refused', () => {
  const notAReport = LINK_PREFIX + zlib.brotliCompressSync(Buffer.from('[1,2,3]')).toString('base64url');
  const out = decodeCertificateLink(notAReport);
  assert.equal(out.ok, false);
  assert.match(out.reason, /did not contain a report/);
});

test('a decompression bomb is refused on length before it is ever decompressed', () => {
  // 60MB of zeroes compresses to a very small token. Without the length check
  // and the decompressor's own output ceiling, one request like this would take
  // a 512MB instance down. The length check is what makes this cheap: an
  // over-long token costs a string comparison, not a decompression.
  const bomb = LINK_PREFIX + 'A'.repeat(MAX_TOKEN_CHARS + 100);
  const out = decodeCertificateLink(bomb);
  assert.equal(out.ok, false);
  assert.match(out.reason, /longer than any link we issue/);
});

test('a small token that would expand past the ceiling is refused by the decompressor', () => {
  const bomb =
    LINK_PREFIX + zlib.brotliCompressSync(Buffer.alloc(4 * 1024 * 1024, 0x41)).toString('base64url');
  assert.ok(bomb.length < MAX_TOKEN_CHARS, 'the bomb has to be small enough to pass the length check');
  const out = decodeCertificateLink(bomb);
  assert.equal(out.ok, false);
  assert.match(out.reason, /damaged or incomplete/);
});
