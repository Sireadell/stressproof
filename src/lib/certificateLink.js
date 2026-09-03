// THE SELF-CONTAINED CERTIFICATE LINK. A verification URL that does not need
// us to have remembered anything.
//
// THE PROBLEM THIS EXISTS TO SOLVE
// --------------------------------
// Reports are held in a Map in the running process. That was defensible while
// this ran on a laptop. On the free hosting plan it is not, and Render's own
// documentation is what settles it: a free web service is spun down after 15
// minutes with no inbound traffic, and "any changes to your web service's
// filesystem are lost every time the service redeploys, restarts, or spins
// down". So the process dies on a schedule, and so does every stored report.
//
// The visible consequence is the one that matters. This product tells people
// "GET /verify/<id> checks a report we are serving, so you need a link rather
// than a hand-built request". Fifteen quiet minutes later every such link ever
// issued answers 404. A dead certificate link on a certification service is
// not a rough edge, it is the product failing at the one thing it claims.
//
// WHAT WAS CONSIDERED AND WHY IT LOST
// ------------------------------------
//   A DATABASE. Render's free Postgres is 1GB, one per workspace, has no
//   backups, and expires 30 days after creation. A certificate link that stops
//   working a month from now is the same failure as one that stops working
//   fifteen minutes from now, only slower and with a database driver, a schema
//   and a connection pool added to a 512MB instance to get there. It also adds
//   a brand new way for verification to break: the database being unreachable.
//
//   WRITING TO DISK. Ruled out by the sentence quoted above. The filesystem is
//   wiped on the exact event we are trying to survive, so this buys nothing at
//   all over the Map it would replace.
//
//   SAYING NOTHING AND DOCUMENTING IT. Honest, and cheap, and still leaves a
//   judge clicking a dead link. Being loudly honest about a broken headline
//   feature is not the same as having a working one.
//
// WHAT WE DO INSTEAD
// ------------------
// Every report is already signed, and the signature is already checkable by
// anyone with no help from us. The only thing the server was actually
// contributing was storage of the bytes. So put the bytes in the link.
//
// A permanent link carries the whole report and its whole certificate,
// compressed, inside the URL. Verifying it is a pure function of the URL: no
// lookup, no memory, no disk, no database. It survives a spin-down, a
// redeploy, a restart, a move to a different host, and this service being shut
// down entirely, because any copy of the code can check it. That is a stronger
// guarantee than a database would have given, not a weaker one, and it needed
// no new infrastructure to get.
//
// THE COST, STATED PLAINLY
// -------------------------
// The link is long, roughly two to three thousand characters. It is meant to
// be clicked or pasted, not read out loud or typed. That is the whole price.
//
// A link that came out too long to be safely served is refused at issue time
// rather than published and left to fail somewhere in the middle of a proxy.

import zlib from 'node:zlib';

/**
 * Version marker. It is in the token rather than in the route so that a future
 * format change is a refusal that names the version, instead of a corrupt
 * decode that produces confident nonsense from an old link.
 */
export const LINK_PREFIX = 'sp1.';

/**
 * The longest token we will hand out.
 *
 * Node refuses an HTTP request whose headers and request line together exceed
 * 16KB, and proxies in front of us have their own smaller limits. Staying well
 * under the smallest of those is what keeps a link that we published from
 * failing at somebody else's edge, which would look exactly like the 404 this
 * whole file exists to remove.
 */
export const MAX_TOKEN_CHARS = 6000;

/**
 * The most we will let a token expand to when decompressing.
 *
 * Compressed input from a stranger is untrusted input. A few hundred bytes of
 * brotli can expand to gigabytes if nobody sets a ceiling, and on a 512MB
 * instance that is a one-request denial of service. `maxOutputLength` makes
 * the decompressor refuse rather than the process die.
 */
const MAX_DECODED_BYTES = 512 * 1024;

/**
 * Pack a report and its certificate into a token.
 *
 * Returns `{ ok: false }` rather than throwing when the result is too long.
 * A missing permanent link is a limitation to state; a link that we knew was
 * over the limit and published anyway is a lie.
 *
 * @param {{ report: object, certificate: object|null }} bundle
 * @returns {{ ok: true, token: string, path: string } | { ok: false, reason: string }}
 */
export function encodeCertificateLink({ report, certificate }) {
  if (!report || typeof report !== 'object') {
    return { ok: false, reason: 'there is no report to put in a link' };
  }

  // Only the two things the verifier needs. The plain-English explanation is
  // deliberately left out: it is not covered by the signature, and putting
  // unsigned prose inside something called a certificate link would invite
  // exactly the misreading this product exists to complain about.
  const json = JSON.stringify({ report, certificate: certificate ?? null });

  const token =
    LINK_PREFIX +
    zlib
      .brotliCompressSync(Buffer.from(json, 'utf8'), {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: json.length,
        },
      })
      .toString('base64url');

  if (token.length > MAX_TOKEN_CHARS) {
    return {
      ok: false,
      reason:
        `this report packs to ${token.length} characters, past the ${MAX_TOKEN_CHARS}-character ceiling a URL can be ` +
        'relied on to carry. Verify it by POSTing the report and certificate to /verify instead.',
    };
  }

  return { ok: true, token, path: `/c/${token}` };
}

/**
 * Unpack a token back into a report and a certificate.
 *
 * Every failure is an answer rather than an exception, for the same reason
 * `verifyCertificate` returns one: "that link is not readable" is a thing a
 * reader needs told, not a stack trace.
 *
 * Nothing here trusts the contents. This function only gets the bytes back;
 * whether they are genuine is decided afterwards by the signature check, which
 * is the only thing that could ever have decided it.
 *
 * @param {string} token
 * @returns {{ ok: true, report: object, certificate: object|null } | { ok: false, reason: string }}
 */
export function decodeCertificateLink(token) {
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'no certificate token supplied' };
  }
  // Length is checked before any decoding work, so an oversized link costs us
  // a string comparison rather than a decompression.
  if (token.length > MAX_TOKEN_CHARS + LINK_PREFIX.length) {
    return { ok: false, reason: 'this certificate link is longer than any link we issue' };
  }
  if (!token.startsWith(LINK_PREFIX)) {
    return {
      ok: false,
      reason: `this is not a StressProof certificate link: it does not start with '${LINK_PREFIX}'`,
    };
  }

  const body = token.slice(LINK_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) {
    return { ok: false, reason: 'this certificate link contains characters that are not part of one' };
  }

  let json;
  try {
    json = zlib
      .brotliDecompressSync(Buffer.from(body, 'base64url'), { maxOutputLength: MAX_DECODED_BYTES })
      .toString('utf8');
  } catch {
    // Covers a truncated paste, a link mangled by a mail client, and a
    // deliberate decompression bomb, all of which are the same answer to a
    // reader: this link is not usable.
    return { ok: false, reason: 'this certificate link is damaged or incomplete and could not be read' };
  }

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'this certificate link did not contain a readable report' };
  }

  if (!parsed || typeof parsed !== 'object' || !parsed.report || typeof parsed.report !== 'object') {
    return { ok: false, reason: 'this certificate link did not contain a report' };
  }

  return { ok: true, report: parsed.report, certificate: parsed.certificate ?? null };
}
