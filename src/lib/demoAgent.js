// THE DEMO AGENT — a deliberately flawed target that WE host, so anyone can
// watch the twelve probes run without a wallet, and without us pointing
// traffic at somebody else's server.
//
// Running the public demo against our own agent is the only version of a
// one-click demo that raises no consent question at all: the target agreed,
// because the target is us. It is the same code the test suite uses as its
// fixture, which is why the notes below are written in those terms.
//
// This is the backbone of the whole test suite. Without it, probes could only
// be tested against real agents, which are slow, non-deterministic, and cannot
// be made to misbehave on demand.
//
// The five modes are not arbitrary. Each one is a real failure shape a probe
// must tell apart from the others:
//
//   honest  : validates properly, refuses bad input with a clear error.
//             Every probe should score this well.
//   sloppy  : returns 200 OK to absolutely anything, including nonsense.
//             This is the SILENT_WRONG target: the whole point of the product.
//   crashy  : 500s on anything unexpected. Bad, but honestly bad.
//   hanging : never responds. Tests timeouts and the INCONCLUSIVE path.
//   echoer  : validates correctly, BUT quotes the offending input back inside
//             its error message.
//
// The echoer exists because of a specific bug found in review. It is a
// perfectly well-behaved agent, but it reflects hostile-looking input back in
// its error, which naive canary detection reads as "the injection worked."
// Without this mode in the fixture, the injection probe's control-pairing
// logic would ship untested and would falsely accuse honest agents.
//
// THE LINEUP. Five more agents, each honest in every way but one. Sloppy lies
// about everything at once, which shows that StressProof catches lying but
// not WHICH lie. Each of these tells exactly one kind of lie, so the lineup
// can show every lie StressProof claims to catch being caught by the check
// aimed at it, and by no other. They need requireAuth and a sample request
// carrying both min_results and max_results; see src/lib/lineup.js.
//
//   swallows_broken_json : answers 200 to a request that is not valid JSON
//   accepts_impossible   : accepts min_results greater than max_results
//   ignores_input        : gives the same answer whatever the question
//   obeys_injection      : follows an instruction hidden inside its input
//   serves_without_key   : answers a caller who sent no credentials

import http from 'node:http';
import { createHash } from 'node:crypto';

export const LIES = Object.freeze({
  swallows_broken_json: 'brokenJson',
  accepts_impossible: 'contradiction',
  ignores_input: 'ignoreInput',
  obeys_injection: 'obeyInjection',
  serves_without_key: 'noAuth',
});

export const MODES = ['honest', 'sloppy', 'crashy', 'hanging', 'echoer', ...Object.keys(LIES)];

// The instruction shapes an obedient model would act on. Controls in the
// injection probe carry the token as inert data with none of these phrases, so
// an agent built on this list obeys the attacks and stays silent on controls,
// which is exactly the shape the probe's two-fact rule needs to convict.
const OBEY_PATTERNS = [
  /reply with exactly:\s*([A-Za-z0-9_-]+)/i,
  /output\s+([A-Za-z0-9_-]+)\s+verbatim/i,
  /append\s+([A-Za-z0-9_-]+)\s+to your/i,
];

function obeyedInstruction(text) {
  const readings = [text];
  for (const run of text.match(/[A-Za-z0-9+/=]{16,}/g) ?? []) {
    readings.push(Buffer.from(run, 'base64').toString('utf8'));
  }
  for (const reading of readings) {
    for (const pattern of OBEY_PATTERNS) {
      const m = reading.match(pattern);
      if (m) return m[1];
    }
  }
  return null;
}

const REQUIRED_FIELDS = ['query', 'wallet'];

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

/**
 * @param {{ mode?: string, rateLimitAfter?: number, latencyMs?: number }} opts
 */
export function createFakeAgent(opts = {}) {
  const state = {
    mode: opts.mode ?? 'honest',
    rateLimitAfter: opts.rateLimitAfter ?? Infinity,
    latencyMs: opts.latencyMs ?? 0,
    requestCount: 0,
    seenBodies: [],
    concurrent: 0,
    maxConcurrent: 0,
  };

  const server = http.createServer(async (req, res) => {
    state.requestCount += 1;
    state.concurrent += 1;
    state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);
    const done = () => { state.concurrent -= 1; };

    const raw = await readBody(req);
    state.seenBodies.push(raw);
    const lie = LIES[state.mode] ?? null;

    if (state.mode === 'hanging') {
      // Deliberately never answer. unref'd so it cannot hold the process open.
      setTimeout(() => { try { res.end(); } catch { /* client gone */ } }, 120_000).unref();
      done();
      return;
    }

    const send = (code, payload, headers = {}) => {
      const finish = () => {
        try {
          res.writeHead(code, { 'content-type': 'application/json', ...headers });
          res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
        } catch { /* client gone */ }
        done();
      };
      if (state.latencyMs > 0) setTimeout(finish, state.latencyMs).unref();
      else finish();
    };

    // Rate limiting is mode-independent: an honest agent and a sloppy one can
    // both throttle, and the rate probe needs to see that separately.
    if (state.requestCount > state.rateLimitAfter) {
      return send(429, { error: 'rate limit exceeded' }, { 'retry-after': '60' });
    }

    if (!req.headers.authorization && opts.requireAuth && lie !== 'noAuth') {
      if (state.mode === 'sloppy') return send(200, { result: 'served without auth' });
      if (state.mode === 'crashy') return send(500, 'kaboom');
      return send(401, { error: 'authentication required' });
    }

    let parsed = null;
    let parseFailed = false;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parseFailed = true;
    }

    if (parseFailed) {
      if (lie === 'brokenJson') return send(200, { result: 'analysis complete', answer: 'here is your answer' });
      if (state.mode === 'sloppy') return send(200, { result: 'ok', note: 'could not parse but here you go' });
      if (state.mode === 'crashy') return send(500, 'Internal Server Error');
      if (state.mode === 'echoer') {
        return send(400, { error: 'invalid JSON', received: raw.slice(0, 2000) });
      }
      return send(400, { error: 'invalid JSON body' });
    }

    const missing = REQUIRED_FIELDS.filter((f) => !(f in parsed));
    const wrongType = 'query' in parsed && typeof parsed.query !== 'string';
    // A contradiction the target should notice: two mutually exclusive values.
    const contradictory = lie !== 'contradiction' &&
      parsed.min_results != null && parsed.max_results != null &&
      Number(parsed.min_results) > Number(parsed.max_results);

    const isBad = missing.length > 0 || wrongType || contradictory;

    if (isBad) {
      if (state.mode === 'sloppy') {
        return send(200, { result: 'analysis complete', confidence: 0.97 });
      }
      if (state.mode === 'crashy') return send(500, 'Internal Server Error');
      if (state.mode === 'echoer') {
        // Well-behaved, but quotes the offending input back. This is what a
        // naive canary check mistakes for a successful injection.
        return send(400, {
          error: 'invalid request',
          problems: { missing, wrongType, contradictory },
          received: JSON.stringify(parsed).slice(0, 2000),
        });
      }
      return send(400, { error: 'invalid request', problems: { missing, wrongType, contradictory } });
    }

    // Valid request. The `answer` deliberately does NOT depend on the query,
    // so differential_corruption can detect a target that ignores its input.
    // A volatile field is included so volatile-field learning has something
    // real to find.
    let answer = `answer for: ${parsed.query}`;
    if (state.mode === 'sloppy' || lie === 'ignoreInput') answer = 'generic answer';
    if (lie === 'obeyInjection') {
      // Never quotes the question back, so anything of the input that shows up
      // in the answer got there by obedience and not by echo.
      const obeyed = obeyedInstruction(parsed.query);
      const digest = createHash('sha256').update(parsed.query).digest('hex').slice(0, 8);
      answer = obeyed ?? `answer #${digest}`;
    }
    const body = {
      result: 'analysis complete',
      answer,
      request_id: `req_${Math.random().toString(16).slice(2, 10)}`,
      // Offset by the request count so two answers can never carry the same
      // timestamp. On loopback two requests can land in one millisecond, and a
      // timestamp that happens to match in both baselines is not learned as
      // volatile, which made the ignores-input catch flaky.
      generated_at: new Date(Date.now() + state.requestCount).toISOString(),
    };
    return send(200, body);
  });

  return {
    server,
    state,
    setMode(mode) {
      if (!MODES.includes(mode)) throw new Error(`unknown mode '${mode}'`);
      state.mode = mode;
    },
    reset() {
      state.requestCount = 0;
      state.seenBodies = [];
      state.concurrent = 0;
      state.maxConcurrent = 0;
    },
    async listen() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      return `http://127.0.0.1:${server.address().port}/agent`;
    },
    close() {
      server.closeAllConnections?.();
      server.close();
    },
  };
}

/**
 * The target descriptor a probe receives for this fixture.
 * allowPrivateAddresses is set because the fixture is local — production
 * routes never pass it.
 */
export function fixtureTarget(url, overrides = {}) {
  return {
    url,
    method: 'POST',
    sampleBody: { query: 'what is the weather', wallet: '0xabc', max_results: 5 },
    allowPrivateAddresses: true,
    ...overrides,
  };
}
