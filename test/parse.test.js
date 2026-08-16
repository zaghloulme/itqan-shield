'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseHead,
  decodeChunked,
  extractBody,
  cleanHeaders,
  shouldKeepAlive,
} = require('../src/proxy/mitm');

// ------------------------------------------------------------------ parseHead

test('parseHead: normal request', () => {
  const buf = Buffer.from('GET /v1/chat/completions HTTP/1.1\r\nHost: api.openai.com\r\nContent-Type: application/json\r\n\r\n');
  const p = parseHead(buf);
  assert.equal(p.method, 'GET');
  assert.equal(p.target, '/v1/chat/completions');
  assert.equal(p.version, 'HTTP/1.1');
  assert.equal(p.headerMap['host'], 'api.openai.com');
  assert.equal(p.headerMap['content-type'], 'application/json');
  assert.equal(p.headEnd, buf.length);
});

test('parseHead: header names are case-insensitive', () => {
  const buf = Buffer.from('POST / HTTP/1.1\r\nX-Custom-Header: 1\r\nx-custom-header: 2\r\n\r\n');
  const p = parseHead(buf);
  assert.equal(p.headerMap['x-custom-header'], '2', 'last value wins for duplicate name');
});

test('parseHead: incomplete head returns null', () => {
  assert.equal(parseHead(Buffer.from('GET / HTTP/1.1\r\nHost: x')), null);
  assert.equal(parseHead(Buffer.from('')), null);
  assert.equal(parseHead(Buffer.from('GET / HTTP/1.1\r\n\r')), null);
});

test('parseHead: rejects malformed request lines', () => {
  assert.equal(parseHead(Buffer.from('NOT_A_REQUEST\r\n\r\n')), null);
});

// ---------------------------------------------------------------- decodeChunked

test('decodeChunked: decodes a simple chunked body', () => {
  const buf = Buffer.from('4\r\ntest\r\n5\r\nhello\r\n0\r\n\r\n');
  const r = decodeChunked(buf, 0);
  assert.equal(r.body.toString('utf8'), 'testhello');
  assert.equal(r.end, buf.length);
});

test('decodeChunked: empty body', () => {
  const r = decodeChunked(Buffer.from('0\r\n\r\n'), 0);
  assert.equal(r.body.length, 0);
});

test('decodeChunked: chunk extensions are ignored', () => {
  const r = decodeChunked(Buffer.from('4;foo=bar\r\ntest\r\n0\r\n\r\n'), 0);
  assert.equal(r.body.toString('utf8'), 'test');
});

test('decodeChunked: incomplete chunk returns null', () => {
  assert.equal(decodeChunked(Buffer.from('4\r\ntes'), 0), null);
  assert.equal(decodeChunked(Buffer.from('4\r\ntest\r\n5\r\nhel'), 0), null);
});

test('decodeChunked: garbage size returns error', () => {
  const r = decodeChunked(Buffer.from('zz\r\ntest\r\n0\r\n\r\n'), 0);
  assert.equal(r.error, 'bad chunk size');
});

test('decodeChunked: trailing headers consumed', () => {
  const r = decodeChunked(Buffer.from('4\r\ntest\r\n0\r\nX-Footer: 1\r\n\r\n'), 0);
  assert.equal(r.body.toString('utf8'), 'test');
});

// ---------------------------------------------------------------- extractBody

test('extractBody: content-length body', () => {
  const req = Buffer.from('POST / HTTP/1.1\r\nContent-Length: 5\r\n\r\nhello');
  const p = parseHead(req);
  const r = extractBody(req, p);
  assert.equal(r.body.toString('utf8'), 'hello');
  assert.equal(r.end, req.length);
  assert.equal(r.source, 'content-length');
});

test('extractBody: content-length pending until complete', () => {
  const p = parseHead(Buffer.from('POST / HTTP/1.1\r\nContent-Length: 10\r\n\r\nabc'));
  const r = extractBody(Buffer.from('POST / HTTP/1.1\r\nContent-Length: 10\r\n\r\nabc'), p);
  assert.equal(r.pending, true);
});

test('extractBody: content-length too large is rejected', () => {
  const req = Buffer.from('POST / HTTP/1.1\r\nContent-Length: 999999999\r\n\r\n');
  const p = parseHead(req);
  const r = extractBody(req, p);
  assert.equal(r.error, 'request body too large');
});

test('extractBody: bad content-length is rejected', () => {
  const req = Buffer.from('POST / HTTP/1.1\r\nContent-Length: -5\r\n\r\n');
  const p = parseHead(req);
  const r = extractBody(req, p);
  assert.equal(r.error, 'bad content-length');
});

test('extractBody: chunked body', () => {
  const req = Buffer.from('POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n');
  const p = parseHead(req);
  const r = extractBody(req, p);
  assert.equal(r.body.toString('utf8'), 'abc');
  assert.equal(r.source, 'chunked');
});

test('extractBody: no body (GET)', () => {
  const req = Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
  const p = parseHead(req);
  const r = extractBody(req, p);
  assert.equal(r.body.length, 0);
  assert.equal(r.source, 'none');
});

// ---------------------------------------------------------------- cleanHeaders

test('cleanHeaders: strips hop-by-hop headers', () => {
  const out = cleanHeaders({
    host: 'api.openai.com',
    'user-agent': 'curl',
    connection: 'keep-alive',
    'proxy-connection': 'Keep-Alive',
    'transfer-encoding': 'chunked',
    authorization: 'Bearer sk-123',
    'content-length': '5',
  });
  assert.equal(out.host, 'api.openai.com');
  assert.equal(out['user-agent'], 'curl');
  assert.equal(out.authorization, 'Bearer sk-123', 'auth headers must survive');
  assert.equal(out.connection, undefined);
  assert.equal(out['proxy-connection'], undefined);
  assert.equal(out['transfer-encoding'], undefined);
  assert.equal(out['content-length'], undefined, 'length is recomputed by the proxy');
});

test('cleanHeaders: keepLength preserves content-length', () => {
  const out = cleanHeaders({ 'content-length': '5' }, { keepLength: true });
  assert.equal(out['content-length'], '5');
});

// ------------------------------------------------------------- shouldKeepAlive

test('shouldKeepAlive: HTTP/1.1 keeps alive by default', () => {
  assert.equal(shouldKeepAlive({ version: 'HTTP/1.1', headerMap: {} }), true);
});

test('shouldKeepAlive: connection: close disables', () => {
  assert.equal(
    shouldKeepAlive({ version: 'HTTP/1.1', headerMap: { connection: 'close' } }),
    false
  );
});

test('shouldKeepAlive: HTTP/1.0 closes by default', () => {
  assert.equal(shouldKeepAlive({ version: 'HTTP/1.0', headerMap: {} }), false);
});

test('shouldKeepAlive: HTTP/1.0 keep-alive enables', () => {
  assert.equal(
    shouldKeepAlive({ version: 'HTTP/1.0', headerMap: { connection: 'Keep-Alive' } }),
    true
  );
});
