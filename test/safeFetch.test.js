// safeFetch tests, against a real socket rather than a mock.
//
// The guard logic is unit-tested in netGuard.test.js. This file checks the
// thing that actually matters: that a real outbound request to a real local
// server is genuinely refused, and that when a request does go out we capture
// enough to judge the response.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { safeFetch } from '../src/lib/safeFetch.js';

let server;
let port;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/slow') {
      // unref so this pending timer cannot keep the test process alive after
      // the client has already given up on it.
      setTimeout(() => { try { res.writeHead(200); res.end('late'); } catch { /* client gone */ } }, 5000).unref();
      return;
    }
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x'.repeat(200_000));
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://127.0.0.1:1/nowhere' });
      res.end();
      return;
    }
    if (req.url === '/error-shape') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'nope' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'x-test': 'yes' });
    res.end(JSON.stringify({ hello: 'world', method: req.method }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(() => {
  // closeAllConnections matters: a keep-alive socket left open would hold the
  // test process open after the assertions are done.
  server?.closeAllConnections?.();
  server?.close();
});

test('a real local server is refused by default', async () => {
  // The single most important assertion in the suite. If this ever passes
  // traffic, StressProof can be pointed at private infrastructure.
  const res = await safeFetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.ok, false);
  assert.ok(res.refusedByGuard, 'must be refused by the guard, not merely fail');
  assert.equal(res.status, null, 'no request should have been made at all');
});

test('the guard refuses before spending any time on the network', async () => {
  const res = await safeFetch('https://192.168.1.1/admin');
  assert.equal(res.ok, false);
  assert.ok(res.refusedByGuard);
  assert.match(res.refusedByGuard, /private/);
});

test('with the explicit test bypass, a request is made and fully captured', async () => {
  const res = await safeFetch(`http://127.0.0.1:${port}/`, { allowPrivateAddresses: true });
  assert.equal(res.ok, true, res.networkError ?? res.refusedByGuard);
  assert.equal(res.status, 200);
  assert.equal(res.headers['x-test'], 'yes');
  assert.equal(JSON.parse(res.body).hello, 'world');
  assert.ok(res.elapsedMs >= 0);
  assert.equal(res.truncated, false);
});

test('the method and body are sent as given', async () => {
  const res = await safeFetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    body: JSON.stringify({ a: 1 }),
    headers: { 'content-type': 'application/json' },
    allowPrivateAddresses: true,
  });
  assert.equal(JSON.parse(res.body).method, 'POST');
});

test('an oversized response is truncated, not swallowed whole', async () => {
  // A target that streams forever must not be able to exhaust our memory.
  const res = await safeFetch(`http://127.0.0.1:${port}/big`, {
    maxBytes: 1024,
    allowPrivateAddresses: true,
  });
  assert.equal(res.truncated, true);
  assert.ok(res.body.length <= 2048, 'kept only a prefix');
});

test('a timeout is reported as an observation, never thrown', async () => {
  // Probes need "it timed out" as data. An exception here would abort a run
  // that should have simply recorded a slow target.
  const res = await safeFetch(`http://127.0.0.1:${port}/slow`, {
    timeoutMs: 300,
    allowPrivateAddresses: true,
  });
  assert.equal(res.ok, false);
  assert.equal(res.networkError, 'ETIMEDOUT');
  assert.ok(res.elapsedMs >= 250);
});

test('a refused connection is reported as an observation, never thrown', async () => {
  const res = await safeFetch('http://127.0.0.1:1/nothing-here', { allowPrivateAddresses: true });
  assert.equal(res.ok, false);
  assert.ok(res.networkError, 'should carry a network error code');
});

test('redirects are captured, never followed', async () => {
  // A redirect is a second destination that never went through the guard.
  // Following one would be a way around every check in netGuard.
  const res = await safeFetch(`http://127.0.0.1:${port}/redirect`, { allowPrivateAddresses: true });
  assert.equal(res.status, 302, 'the 3xx itself is the result');
  assert.equal(res.headers.location, 'http://127.0.0.1:1/nowhere');
});

test('we identify ourselves so an operator can see who sent the traffic', async () => {
  // Anyone reading their server logs should be able to tell instantly who
  // this was and where to complain.
  const seen = [];
  const s = http.createServer((req, res) => {
    seen.push(req.headers['user-agent']);
    res.writeHead(200); res.end('ok');
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  await safeFetch(`http://127.0.0.1:${s.address().port}/`, { allowPrivateAddresses: true });
  s.closeAllConnections?.();
  s.close();
  assert.match(seen[0], /StressProof/);
});
