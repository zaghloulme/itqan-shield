'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { startProxy } = require('../src/proxy/server');
const { makeUpstream, makeTestPki, tmpDataDir, quietLogger, MitmClient } = require('./helpers');

/**
 * Boot a proxy against a local TLS upstream signed by a throwaway CA.
 * Returns everything a test needs, including the proxy's own CA PEM.
 */
async function setup({ inspector, upstream = {} } = {}) {
  const dataDir = tmpDataDir();
  const pki = makeTestPki();
  const upstreamServer = await makeUpstream({ tls: true, pki });
  const proxy = await startProxy({
    port: 0,
    dataDir,
    logger: quietLogger,
    inspector,
    // MITM the test upstream's port as well as the default 443.
    interceptPorts: [443, upstreamServer.port],
    upstream: { ca: pki.caPem, rejectUnauthorized: true, ...upstream },
  });
  const caPem = fs.readFileSync(path.join(dataDir, 'ca.pem'), 'utf8');
  return { dataDir, pki, upstream: upstreamServer, proxy, caPem, port: proxy.port };
}

function teardown(t, s) {
  t.after(async () => {
    await s.proxy.stop();
    await new Promise((res) => s.upstream.server.close(res));
  });
}

test('MITM: GET request round-trips with correct body', async (t) => {
  const s = await setup();
  teardown(t, s);
  const c = new MitmClient({ proxyPort: s.port, targetPort: s.upstream.port, caPem: s.caPem });
  await c.connect();
  const res = await c.request({ path: '/hello' });
  assert.equal(res.status, 200);
  const parsed = JSON.parse(res.body.toString('utf8'));
  assert.equal(parsed.method, 'GET');
  assert.equal(parsed.url, '/hello');
  assert.equal(s.upstream.requests.length, 1);
  assert.equal(s.upstream.requests[0].headers.host, 'localhost');
  c.close();
});

test('MITM: POST JSON body arrives intact upstream', async (t) => {
  const s = await setup();
  teardown(t, s);
  const payload = JSON.stringify({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'أهلاً بالعالم — governance test ✓' }],
  });
  const c = new MitmClient({ proxyPort: s.port, targetPort: s.upstream.port, caPem: s.caPem });
  await c.connect();
  const res = await c.request({
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-test-123' },
    body: payload,
  });
  assert.equal(res.status, 200);
  assert.equal(s.upstream.requests[0].bodyText, payload, 'exact bytes preserved');
  assert.equal(s.upstream.requests[0].headers.authorization, 'Bearer sk-test-123', 'auth header preserved');
  c.close();
});

test('MITM: keep-alive serves multiple requests on one connection', async (t) => {
  const s = await setup();
  teardown(t, s);
  const c = new MitmClient({ proxyPort: s.port, targetPort: s.upstream.port, caPem: s.caPem });
  await c.connect();
  for (let i = 1; i <= 3; i++) {
    const res = await c.request({ path: `/req/${i}` });
    assert.equal(res.status, 200);
  }
  assert.equal(s.upstream.requests.length, 3);
  c.close();
});

test('MITM: chunked request body is decoded and reframed upstream', async (t) => {
  const s = await setup();
  teardown(t, s);
  const c = new MitmClient({ proxyPort: s.port, targetPort: s.upstream.port, caPem: s.caPem });
  await c.connect();
  const res = await c.request({
    method: 'POST',
    path: '/chunked',
    chunked: 'hello|world|12345',
  });
  assert.equal(res.status, 200);
  const req = s.upstream.requests[0];
  assert.equal(req.bodyText, 'helloworld12345', 'chunked body decoded correctly');
  assert.equal(req.headers['transfer-encoding'], undefined, 'upstream sees content-length framing');
  assert.ok(req.headers['content-length'], 'upstream sees content-length');
  c.close();
});

test('MITM: SSE streaming response passes through intact', async (t) => {
  const s = await setup();
  teardown(t, s);
  const c = new MitmClient({ proxyPort: s.port, targetPort: s.upstream.port, caPem: s.caPem });
  await c.connect();
  const res = await c.request({ path: '/sse' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream');
  const text = res.body.toString('utf8');
  const order = ['data: first', 'data: second', 'data: third'];
  let prev = -1;
  for (const ev of order) {
    const at = text.indexOf(ev);
    assert.ok(at > prev, `event "${ev}" appears in order`);
    prev = at;
  }
  c.close();
});

test('MITM: large (1 MB) response transfers completely', async (t) => {
  const s = await setup();
  teardown(t, s);
  const c = new MitmClient({ proxyPort: s.port, targetPort: s.upstream.port, caPem: s.caPem });
  await c.connect();
  const res = await c.request({ path: '/big' });
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1024 * 1024);
  c.close();
});

test('MITM: slow upstream does not time out prematurely', async (t) => {
  const s = await setup();
  teardown(t, s);
  const c = new MitmClient({ proxyPort: s.port, targetPort: s.upstream.port, caPem: s.caPem });
  await c.connect();
  const res = await c.request({ path: '/slow' });
  assert.equal(res.status, 200);
  assert.equal(res.body.toString('utf8'), 'slow-response');
  c.close();
});

test('filter: blocking inspector returns 403 and stops the request', async (t) => {
  const s = await setup({
    inspector: {
      failOpen: true,
      async inspectRequest(ctx) {
        if (ctx.body.toString('utf8').includes('BLOCKME')) {
          return { action: 'block', status: 403, body: 'blocked by policy' };
        }
        return { action: 'pass' };
      },
      recordDecision() {},
    },
  });
  teardown(t, s);
  const c = new MitmClient({ proxyPort: s.port, targetPort: s.upstream.port, caPem: s.caPem });
  await c.connect();
  const res = await c.request({
    method: 'POST',
    path: '/v1/chat/completions',
    body: 'prompt with BLOCKME inside',
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.toString('utf8'), 'blocked by policy');
  assert.equal(s.upstream.requests.length, 0, 'blocked request never reaches upstream');
  c.close();
});

test('filter: clean traffic still passes when inspector is installed', async (t) => {
  const s = await setup({
    inspector: {
      failOpen: true,
      async inspectRequest() {
        return { action: 'pass' };
      },
      recordDecision() {},
    },
  });
  teardown(t, s);
  const c = new MitmClient({ proxyPort: s.port, targetPort: s.upstream.port, caPem: s.caPem });
  await c.connect();
  const res = await c.request({ path: '/ok' });
  assert.equal(res.status, 200);
  c.close();
});

test('filter: inspector throwing fails open by default (request passes)', async (t) => {
  const s = await setup({
    inspector: {
      failOpen: true,
      async inspectRequest() {
        throw new Error('boom');
      },
      recordDecision() {},
    },
  });
  teardown(t, s);
  const c = new MitmClient({ proxyPort: s.port, targetPort: s.upstream.port, caPem: s.caPem });
  await c.connect();
  const res = await c.request({ path: '/resilient' });
  assert.equal(res.status, 200);
  c.close();
});

test('security: client that does not trust the proxy CA is rejected', async (t) => {
  const s = await setup();
  teardown(t, s);
  const otherPki = makeTestPki(); // different CA
  const c = new MitmClient({
    proxyPort: s.port,
    targetPort: s.upstream.port,
    caPem: otherPki.caPem,
    tlsRejectUnauthorized: true,
  });
  await assert.rejects(c.connect(), /unable to verify|self.signed|ERR_TLS_CERT_ALTNAME|error/);
});

test('security: oversized declared body is rejected with 400', async (t) => {
  const s = await setup();
  teardown(t, s);
  const c = new MitmClient({ proxyPort: s.port, targetPort: s.upstream.port, caPem: s.caPem });
  await c.connect();
  const res = await c.request({
    method: 'POST',
    path: '/',
    headers: { 'Content-Length': '999999999' },
  });
  assert.equal(res.status, 400);
  c.close();
});

test('plain HTTP: proxy-style absolute-URL passthrough', async (t) => {
  const upstream = await makeUpstream({ tls: false });
  const dataDir = tmpDataDir();
  const proxy = await startProxy({ port: 0, dataDir, logger: quietLogger });
  t.after(async () => {
    await proxy.stop();
    await new Promise((res) => upstream.server.close(res));
  });

  const res = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: proxy.port, method: 'GET', path: `http://127.0.0.1:${upstream.port}/plain` },
      (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString() }));
      }
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).url, '/plain');
});

test('raw CONNECT: non-443 ports tunnel without interception', async (t) => {
  const upstream = await makeUpstream({ tls: false });
  const dataDir = tmpDataDir();
  const proxy = await startProxy({ port: 0, dataDir, logger: quietLogger });
  t.after(async () => {
    await proxy.stop();
    await new Promise((res) => upstream.server.close(res));
  });

  // Drive the raw socket directly: CONNECT, then plaintext HTTP over the tunnel.
  const net = require('net');
  const raw = await new Promise((resolve, reject) => {
    const s = net.connect(proxy.port, '127.0.0.1');
    s.on('connect', () => resolve(s));
    s.on('error', reject);
  });

  const { parseHttpResponse } = require('./helpers');
  let buf = Buffer.alloc(0);
  const awaitResponse = () =>
    new Promise((resolve) => {
      raw.on('data', function onD(d) {
        buf = Buffer.concat([buf, d]);
        const parsed = parseHttpResponse(buf);
        if (parsed) {
          raw.removeListener('data', onD);
          buf = buf.subarray(parsed.headEnd + parsed.body.length);
          resolve(parsed);
        }
      });
    });

  raw.write(`CONNECT localhost:${upstream.port} HTTP/1.1\r\nHost: localhost:${upstream.port}\r\n\r\n`);
  const connectRes = await awaitResponse();
  assert.equal(connectRes.status, 200);

  raw.write('GET /tunnel HTTP/1.1\r\nHost: localhost\r\n\r\n');
  const res = await awaitResponse();
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body.toString()).url, '/tunnel');
  raw.destroy();
});

test('stress: 10 concurrent connections × 3 requests each all succeed', async (t) => {
  const s = await setup();
  teardown(t, s);
  const clients = [];
  for (let i = 0; i < 10; i++) {
    clients.push(new MitmClient({ proxyPort: s.port, targetPort: s.upstream.port, caPem: s.caPem }));
  }
  await Promise.all(clients.map((c) => c.connect()));
  const results = await Promise.all(
    clients.map((c, i) => Promise.all([1, 2, 3].map((n) => c.request({ path: `/c${i}/r${n}` }))))
  );
  for (const group of results) {
    for (const res of group) assert.equal(res.status, 200);
  }
  assert.equal(s.upstream.requests.length, 30);
  clients.forEach((c) => c.close());
});

test('port fallback: busy port rolls to the next free one', async (t) => {
  const blocker = await new Promise((resolve) => {
    const srv = http.createServer(() => {});
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
  const busyPort = blocker.address().port;
  const dataDir = tmpDataDir();
  const proxy = await startProxy({ port: busyPort, dataDir, logger: quietLogger });
  t.after(async () => {
    await proxy.stop();
    await new Promise((res) => blocker.close(res));
  });
  assert.notEqual(proxy.port, busyPort);
  assert.ok(proxy.port > 0);
});

test('stop() actually closes the listener', async (t) => {
  const dataDir = tmpDataDir();
  const proxy = await startProxy({ port: 0, dataDir, logger: quietLogger });
  const port = proxy.port;
  await proxy.stop();
  await assert.rejects(
    new Promise((resolve, reject) => {
      const sock = require('net').connect(port, '127.0.0.1', resolve);
      sock.on('error', reject);
    }),
    /ECONNREFUSED/
  );
});
