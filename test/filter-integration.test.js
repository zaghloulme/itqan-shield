const { test } = require('node:test');


const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startProxy } = require('../src/proxy/server');
const { createEngine } = require('../src/filter/engine');
const { emptyStore, addLocalRule } = require('../src/filter/keywords');
const { makeUpstream, makeTestPki, tmpDataDir, quietLogger, MitmClient } = require('./helpers');

/**
 * Boot the full stack the way the app does: proxy + engine-inspector.
 * `askForDecision` is injected so the dialog behavior is testable headless.
 */
// One PKI + one proxy CA per test FILE (RSA keygen is slow; CA+leaf caches
// make the first generation serve the whole file).
const sharedDataDir = tmpDataDir();
const sharedPki = makeTestPki();

async function setup({ rules, askForDecision, agentSettings = {}, askTimeoutMs = 2000, customAgents = [] }) {
  const upstreamServer = await makeUpstream({ tls: true, pki: sharedPki });

  const store = emptyStore();
  for (const r of rules) addLocalRule(store, r);

  const settings = { agents: agentSettings, customAgents, askTimeoutMs };
  const decisions = [];
  const engine = createEngine({
    store,
    settings,
    askForDecision: async (q) => {
      decisions.push(q);
      return typeof askForDecision === 'function' ? askForDecision(q) : { allow: false };
    },
    onDecision: (e) => decisions.push(e),
    askTimeoutMs,
    logger: quietLogger,
  });

  const proxy = await startProxy({
    port: 0,
    dataDir: sharedDataDir,
    logger: quietLogger,
    inspector: {
      failOpen: true,
      inspectRequest: (ctx) => engine.inspectRequest(ctx),
      recordDecision: () => {},
    },
    interceptPorts: [443, upstreamServer.port],
    upstream: { ca: sharedPki.caPem, rejectUnauthorized: true },
  });

  const caPem = fs.readFileSync(path.join(sharedDataDir, 'ca.pem'), 'utf8');
  return { dataDir: sharedDataDir, pki: sharedPki, upstream: upstreamServer, proxy, caPem, port: proxy.port, engine, decisions };
}

function teardown(t, s) {
  t.after(async () => {
    await s.proxy.stop();
    await new Promise((res) => s.upstream.server.close(res));
  });
}

// Maps CONNECT 'localhost' to a filterable agent so tests never hit real DNS.
const LOCAL_AGENT = [{ id: 'test-local', name: 'Test Local', hosts: ['localhost'] }];

const KEYWORD = {
  text: 'production-database',
  mode: 'word',
  action: 'ask',
  category: 'blocked',
};

function promptBody(text) {
  return JSON.stringify({ model: 'gpt-test', messages: [{ role: 'user', content: text }] });
}

test('filter: keyword hit on an enabled agent asks and deny blocks with 403', async (t) => {
  const s = await setup({ rules: [KEYWORD], customAgents: LOCAL_AGENT, askForDecision: () => ({ allow: false }) });
  teardown(t, s);
  const c = new MitmClient({ proxyPort: s.port, targetPort: s.upstream.port, caPem: s.caPem });
  await c.connect();
  const res = await c.request({
    method: 'POST',
    path: '/v1/chat/completions',
    body: promptBody('please connect to the production-database now'),
  });
  assert.equal(res.status, 403, 'denied request must be blocked');
  assert.match(res.body.toString(), /production-database/);
  assert.equal(s.upstream.requests.length, 0, 'blocked request never reaches upstream');
  assert.ok(s.decisions.some((d) => d.decision === 'deny'), 'decision logged');
  c.close();
});

test('filter: allow resolves the request through to upstream', async (t) => {
  const s = await setup({ rules: [KEYWORD], customAgents: LOCAL_AGENT, askForDecision: () => ({ allow: true }) });
  teardown(t, s);
  const c = new MitmClient({ proxyPort: s.port, targetPort: s.upstream.port, caPem: s.caPem });
  await c.connect();
  const res = await c.request({
    method: 'POST',
    path: '/v1/chat/completions',
    body: promptBody('connect to the production-database'),
  });
  assert.equal(res.status, 200, 'allowed request passes');
  assert.equal(s.upstream.requests.length, 1);
  c.close();
});

test('filter: session allow auto-passes the next identical hit without asking', async (t) => {
  let asks = 0;
  const s = await setup({
    rules: [KEYWORD],
    customAgents: LOCAL_AGENT,
    askForDecision: () => {
      asks += 1;
      return { allow: true, session: true };
    },
  });
  teardown(t, s);
  const c = new MitmClient({ proxyPort: s.port, targetPort: s.upstream.port, caPem: s.caPem });
  await c.connect();
  const r1 = await c.request({ method: 'POST', path: '/v1/chat/completions', body: promptBody('the production-database') });
  const r2 = await c.request({ method: 'POST', path: '/v1/chat/completions', body: promptBody('the production-database') });
  const r3 = await c.request({ method: 'POST', path: '/v1/chat/completions', body: promptBody('the production-database') });
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r3.status, 200);
  assert.equal(asks, 1, 'only the first hit asks; session allow covers the rest');
  c.close();
});

test('filter: session allow is per agent — other agents still ask', async () => {
  const store = emptyStore();
  addLocalRule(store, KEYWORD);
  const asks = [];
  const engine = createEngine({
    store,
    settings: {
      agents: {},
      customAgents: [
        { id: 'a', name: 'Agent A', hosts: ['a.example'] },
        { id: 'b', name: 'Agent B', hosts: ['b.example'] },
      ],
    },
    askForDecision: async (q) => {
      asks.push(q.agent.id);
      return { allow: true, session: true };
    },
    logger: quietLogger,
  });
  const body = Buffer.from(promptBody('the production-database'));
  await engine.inspectRequest({ host: 'a.example', method: 'POST', target: '/', body });
  await engine.inspectRequest({ host: 'a.example', method: 'POST', target: '/', body });
  await engine.inspectRequest({ host: 'b.example', method: 'POST', target: '/', body });
  assert.deepEqual(asks, ['a', 'b'], 'agent B still asks after agent A session-allow');
});

test('filter: custom agent added by the user is filtered', async (t) => {
  const s = await setup({
    rules: [KEYWORD],
    agentSettings: {},
    customAgents: [{ id: 'local-agent', name: 'Local Agent', hosts: ['localhost'] }],
    askForDecision: () => ({ allow: false }),
  });
  teardown(t, s);
  const c = new MitmClient({ proxyPort: s.port, targetPort: s.upstream.port, caPem: s.caPem, targetHost: 'localhost' });
  await c.connect();
  const res = await c.request({ method: 'POST', path: '/v1/chat/completions', body: promptBody('the production-database') });
  assert.equal(res.status, 403, 'custom agent is filtered');
  c.close();
});

test('filter: disabled agent passes everything untouched', async (t) => {
  const s = await setup({
    rules: [KEYWORD],
    customAgents: LOCAL_AGENT,
    agentSettings: { 'test-local': { enabled: false } },
    askForDecision: () => ({ allow: false }), // would deny if asked
  });
  teardown(t, s);
  const c = new MitmClient({ proxyPort: s.port, targetPort: s.upstream.port, caPem: s.caPem, targetHost: 'localhost' });
  await c.connect();
  const res = await c.request({ method: 'POST', path: '/v1/chat/completions', body: promptBody('the production-database') });
  assert.equal(res.status, 200, 'disabled agent is not filtered');
  assert.equal(s.upstream.requests.length, 1);
  c.close();
});

test('filter: unmanaged host (no agent match) passes', async (t) => {
  const s = await setup({ rules: [KEYWORD], customAgents: [] });
  teardown(t, s);
  const c = new MitmClient({ proxyPort: s.port, targetPort: s.upstream.port, caPem: s.caPem, targetHost: 'localhost' });
  await c.connect();
  const res = await c.request({ method: 'POST', path: '/v1/chat/completions', body: promptBody('the production-database') });
  assert.equal(res.status, 200);
  c.close();
});

test('filter: silent block action (no ask dialog)', async (t) => {
  const s = await setup({
    rules: [{ ...KEYWORD, action: 'block' }],
    askForDecision: () => {
      throw new Error('should never ask');
    },
  });
  teardown(t, s);
  const c = new MitmClient({ proxyPort: s.port, targetPort: s.upstream.port, caPem: s.caPem, targetHost: 'chatgpt.com' });
  await c.connect();
  const res = await c.request({ method: 'POST', path: '/v1/chat/completions', body: promptBody('the production-database') });
  assert.equal(res.status, 403, 'silent block');
  assert.equal(s.upstream.requests.length, 0);
  c.close();
});

test('filter: clean traffic never asks', async (t) => {
  let asks = 0;
  const s = await setup({
    rules: [KEYWORD],
    customAgents: LOCAL_AGENT,
    askForDecision: () => {
      asks += 1;
      return { allow: false };
    },
  });
  teardown(t, s);
  const c = new MitmClient({ proxyPort: s.port, targetPort: s.upstream.port, caPem: s.caPem, targetHost: 'localhost' });
  await c.connect();
  const res = await c.request({ method: 'POST', path: '/v1/chat/completions', body: promptBody('a totally benign question about the weather') });
  assert.equal(res.status, 200);
  assert.equal(asks, 0);
  c.close();
});

test('filter: ask timeout denies by default (fail-closed)', async (t) => {
  const s = await setup({
    rules: [KEYWORD],
    askTimeoutMs: 300,
    askForDecision: () => new Promise((r) => setTimeout(() => r({ allow: true }), 5000)), // answers late
  });
  teardown(t, s);
  const c = new MitmClient({ proxyPort: s.port, targetPort: s.upstream.port, caPem: s.caPem, targetHost: 'chatgpt.com' });
  await c.connect();
  const res = await c.request({ method: 'POST', path: '/v1/chat/completions', body: promptBody('the production-database') });
  assert.equal(res.status, 403, 'timeout denies');
  assert.equal(s.upstream.requests.length, 0);
  c.close();
});

test('filter: regex keyword via engine', async (t) => {
  const s = await setup({
    rules: [{ text: 'iban', pattern: '[A-Z]{2}\\d{2}[A-Z0-9]{10,30}', mode: 'regex', action: 'ask', category: 'pii' }],
    askForDecision: () => ({ allow: false }),
  });
  teardown(t, s);
  const c = new MitmClient({ proxyPort: s.port, targetPort: s.upstream.port, caPem: s.caPem, targetHost: 'chatgpt.com' });
  await c.connect();
  const res = await c.request({ method: 'POST', path: '/v1/chat/completions', body: promptBody('wire to EG380019000500000002263180002') });
  assert.equal(res.status, 403);
  c.close();
});
