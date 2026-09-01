// SIGNED CERTIFICATES — so a verdict can be checked without trusting us.
//
// A certification service that cannot be audited is just an opinion with a
// logo. Every report is signed, and anyone can recover the signing address
// from the report itself. If a single character of a report is altered, the
// signature stops matching.
//
// Deliberately OFF-CHAIN ONLY. Publishing certificates on-chain was
// considered and cut: a signature anyone can verify offline gives the same
// guarantee at zero cost, zero latency, and no risk of a failed broadcast
// degrading a good verdict. That is on the "do not build" list, not the
// roadmap-we-secretly-want list.
//
// The load-bearing detail is canonical serialisation. If the same report can
// serialise two different ways, verification fails at random and the whole
// mechanism is worse than useless — it would call honest reports forged. So
// keys are sorted recursively and the result is compared byte for byte.

import { Wallet, TypedDataEncoder, verifyTypedData, id as keccakId } from 'ethers';

/**
 * chainId 8453 (Base) is used purely as an EIP-712 domain separator. It ties a
 * signature to this product on this chain so a signature cannot be replayed
 * against a different domain. No chain call is ever made.
 */
export const DOMAIN = Object.freeze({
  name: 'StressProof Certification',
  version: '1',
  chainId: 8453,
});

/**
 * The signed fields.
 *
 * `reportHash` covers the full report body, so the whole report is protected
 * without putting a variable-length structure inside the typed data. The other
 * fields are duplicated out of the report so that a reader can see the
 * headline claims without having to parse anything.
 */
export const TYPES = Object.freeze({
  Certification: [
    { name: 'target', type: 'string' },
    { name: 'verdict', type: 'string' },
    { name: 'score', type: 'uint256' },
    { name: 'probesCompleted', type: 'uint256' },
    { name: 'silentWrongCount', type: 'uint256' },
    { name: 'reportHash', type: 'string' },
    { name: 'timestamp', type: 'uint256' },
  ],
});

/**
 * Serialise deterministically: object keys sorted recursively, arrays left in
 * order, no incidental whitespace.
 *
 * Arrays keep their order on purpose — a probe timeline is meaningful in
 * sequence, and sorting it would destroy the evidence it carries.
 */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  const parts = keys
    .filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`);
  return `{${parts.join(',')}}`;
}

/** Stable hash of a full report body. */
export function hashReport(report) {
  return keccakId(canonicalize(report));
}

let cachedSigner;
let warnedNoSigner = false;

function getSigner() {
  if (cachedSigner !== undefined) return cachedSigner;
  const key = process.env.STRESSPROOF_SIGNER_PRIVATE_KEY;
  cachedSigner = key ? new Wallet(key) : null;
  return cachedSigner;
}

/** Published in the README so anyone can check signatures against it. */
export function getSignerAddress() {
  return getSigner()?.address ?? null;
}

/**
 * Sign a finished report.
 *
 * Returns null rather than throwing when no signing key is configured. A
 * missing key must degrade the report to "unsigned", never fail an otherwise
 * good certification — same treatment every optional signal gets here.
 *
 * @param {object} report a finished report object
 * @param {{ signer?: import('ethers').Wallet, now?: number }} [opts]
 */
export async function signReport(report, { signer = getSigner(), now = Date.now() } = {}) {
  if (!signer) {
    if (!warnedNoSigner && process.env.NODE_ENV === 'production') {
      warnedNoSigner = true;
      console.warn('STRESSPROOF_SIGNER_PRIVATE_KEY not set: reports are shipping unsigned.');
    }
    return null;
  }

  const reportHash = hashReport(report);
  const value = {
    target: String(report.target ?? ''),
    verdict: String(report.verdict ?? ''),
    // EIP-712 uint256 cannot carry a fraction; the score is published as an
    // integer percentage everywhere else too, so nothing is lost.
    score: Math.round(Number(report.score ?? 0)),
    probesCompleted: Number(report.probesCompleted ?? 0),
    silentWrongCount: Number(report.silentWrongCount ?? 0),
    reportHash,
    timestamp: Math.floor(now / 1000),
  };

  const signature = await signer.signTypedData(DOMAIN, TYPES, value);
  return {
    ...value,
    signature,
    signerAddress: signer.address,
    attestationHash: TypedDataEncoder.hash(DOMAIN, TYPES, value),
  };
}

/**
 * Verify a certificate against the report it claims to describe.
 *
 * Two independent checks, and both must pass:
 *   1. the report still hashes to the value that was signed (nothing edited)
 *   2. the signature recovers to the address it claims (nobody else signed it)
 *
 * Returns a structured result rather than throwing, because "this certificate
 * is invalid" is an answer, not an error.
 */
export function verifyCertificate(report, certificate) {
  if (!certificate || typeof certificate !== 'object') {
    return { valid: false, reason: 'no certificate supplied' };
  }
  const required = ['target', 'verdict', 'score', 'probesCompleted', 'silentWrongCount', 'reportHash', 'timestamp', 'signature', 'signerAddress'];
  for (const field of required) {
    if (certificate[field] === undefined) return { valid: false, reason: `certificate is missing '${field}'` };
  }

  const recomputed = hashReport(report);
  if (recomputed !== certificate.reportHash) {
    return {
      valid: false,
      reason: 'the report does not match its certificate — it has been altered since signing',
      expected: certificate.reportHash,
      actual: recomputed,
    };
  }

  const value = {
    target: certificate.target,
    verdict: certificate.verdict,
    score: certificate.score,
    probesCompleted: certificate.probesCompleted,
    silentWrongCount: certificate.silentWrongCount,
    reportHash: certificate.reportHash,
    timestamp: certificate.timestamp,
  };

  let recovered;
  try {
    recovered = verifyTypedData(DOMAIN, TYPES, value, certificate.signature);
  } catch (err) {
    return { valid: false, reason: `signature could not be read (${err.shortMessage ?? err.message})` };
  }

  if (recovered.toLowerCase() !== String(certificate.signerAddress).toLowerCase()) {
    return {
      valid: false,
      reason: 'the signature was not produced by the address it claims',
      recovered,
      claimed: certificate.signerAddress,
    };
  }

  return { valid: true, signer: recovered, signedAt: certificate.timestamp };
}

/** Test-only: clear the memoised signer so env changes take effect. */
export function _resetSignerCache() {
  cachedSigner = undefined;
  warnedNoSigner = false;
}
