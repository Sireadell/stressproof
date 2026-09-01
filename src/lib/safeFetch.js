// One HTTP request, made safely, with everything captured.
//
// Used by both the consent check and every probe, so the safety properties
// hold everywhere by construction rather than by remembering to apply them.
//
// THE PINNED-ADDRESS PROBLEM
// ---------------------------
// Validating a hostname and then making an ordinary request leaves a gap: the
// name is resolved twice — once by the check, once by the connection — and a
// hostile operator can return a harmless public address the first time and a
// private one the second. The check passes, the connection goes somewhere
// else. It is a race the attacker controls.
//
// The fix is to resolve once, validate that result, then force the connection
// to that exact address. Node's `lookup` hook lets us do that: the address is
// decided by us, not re-resolved by the socket layer.
//
// Redirects are never followed, for the same reason — a redirect is a second
// destination that never went through the check. A 3xx is captured and
// reported as-is.

import http from 'node:http';
import https from 'node:https';
import { checkTarget } from './netGuard.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 256 * 1024;

/**
 * A DNS lookup that always returns the address we already validated.
 * This is what closes the re-resolution gap described above.
 */
function pinnedLookup(address) {
  const family = address.includes(':') ? 6 : 4;
  return (_hostname, options, callback) => {
    if (options && options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

/**
 * Make one request and capture everything a probe needs to judge it.
 *
 * Never throws for network-level problems — a refused connection, a timeout
 * and a reset are all *observations about the target*, and a probe needs them
 * as data rather than as exceptions. Only programmer error throws.
 *
 * @returns {Promise<{
 *   ok: boolean, status: number|null, headers: object, body: string,
 *   bytes: number, truncated: boolean, elapsedMs: number,
 *   networkError: string|null, refusedByGuard: string|null
 * }>}
 */
export async function safeFetch(rawUrl, {
  method = 'GET',
  headers = {},
  body = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  allowPrivateAddresses = false,
  bodyWriter = null,
} = {}) {
  const started = Date.now();

  const guard = await checkTarget(rawUrl, { allowPrivateAddresses });
  if (!guard.ok) {
    return {
      ok: false,
      status: null,
      headers: {},
      body: '',
      bytes: 0,
      truncated: false,
      elapsedMs: Date.now() - started,
      networkError: null,
      refusedByGuard: guard.reason,
    };
  }

  const url = guard.url ?? new URL(rawUrl);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  const pinTo = guard.testModeBypass ? null : guard.addresses[0];

  const options = {
    method,
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    headers: {
      // Identify ourselves plainly. An operator reading their logs should be
      // able to tell instantly who sent this and where to complain.
      'user-agent': 'StressProof/0.1 (+https://stressproof.dev)',
      accept: '*/*',
      ...headers,
    },
    timeout: timeoutMs,
  };
  // Only pin when we resolved it ourselves; the test bypass talks to a local
  // fixture and has no validated address to pin to.
  if (pinTo) options.lookup = pinnedLookup(pinTo);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ elapsedMs: Date.now() - started, refusedByGuard: null, ...result });
    };

    const req = transport.request(options, (res) => {
      const chunks = [];
      let bytes = 0;
      let truncated = false;

      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes <= maxBytes) {
          chunks.push(chunk);
          return;
        }
        if (truncated) return;
        truncated = true;
        // Keep the prefix and stop reading: a target that streams forever must
        // not be able to exhaust our memory.
        //
        // Resolve HERE rather than waiting for 'end'. Destroying the stream
        // means 'end' will never fire, so waiting for it hangs the probe
        // forever — which is precisely what an oversized response would have
        // done before a test caught it.
        const partial = Buffer.concat(chunks).toString('utf8');
        res.destroy();
        finish({
          ok: true,
          status: res.statusCode,
          headers: res.headers,
          body: partial,
          bytes,
          truncated: true,
          networkError: null,
        });
      });

      res.on('end', () => {
        finish({
          ok: true,
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          bytes,
          truncated,
          networkError: null,
        });
      });

      res.on('error', (err) => {
        finish({
          ok: false,
          status: res.statusCode ?? null,
          headers: res.headers ?? {},
          body: Buffer.concat(chunks).toString('utf8'),
          bytes,
          truncated,
          networkError: err.code ?? err.message,
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      finish({
        ok: false, status: null, headers: {}, body: '', bytes: 0,
        truncated: false, networkError: 'ETIMEDOUT',
      });
    });

    req.on('error', (err) => {
      finish({
        ok: false, status: null, headers: {}, body: '', bytes: 0,
        truncated: false, networkError: err.code ?? err.message,
      });
    });

    // bodyWriter lets a probe control the *timing* of the body — needed by
    // the slow-client probe, which dribbles it out deliberately.
    if (bodyWriter) bodyWriter(req);
    else if (body != null) req.end(body);
    else req.end();
  });
}
