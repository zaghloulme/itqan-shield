'use strict';

/**
 * TLS interception ("man in the middle") for CONNECT tunnels.
 *
 * Flow for `CONNECT host:443`:
 *   1. Mint a leaf certificate for `host` signed by the local CA.
 *   2. Answer `200 Connection Established`, then terminate TLS with the
 *      client using that leaf cert (tls.TLSSocket in server mode).
 *   3. Parse HTTP/1.x requests off the client's TLS socket, buffer the body,
 *      hand the decoded request to the inspector, and — if allowed —
 *      re-encrypt and forward to the real host (upstream verified against the
 *      public PKI, rejectUnauthorized: true).
 *   4. Buffer the upstream response, then write it back to the client with a
 *      rewritten Content-Length. Supports keep-alive (serialized requests).
 *
 * Non-443 CONNECTs are passed through as raw TCP pipes (no interception).
 * Requests with an `Upgrade` header fall back to a raw bidirectional pipe.
 */

const tls = require('tls');
const https = require('https');
const http = require('http');
const net = require('net');
const { getHostCertificate } = require('./ca');

const MAX_REQUEST_BODY = 16 * 1024 * 1024; // 16 MB
const MAX_RESPONSE_BODY = 64 * 1024 * 1024; // 64 MB
const UPSTREAM_TIMEOUT = 30000;

const HOP_BY_HOP = new Set([
  'connection',
  'proxy-connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
]);

// ------------------------------------------------------------------ parsing

/** Parse the request head (request line + headers) from a buffer. Null if incomplete. */
function parseHead(buf) {
  const idx = buf.indexOf('\r\n\r\n');
  if (idx === -1) return null;
  const head = buf.subarray(0, idx).toString('latin1');
  const lines = head.split('\r\n');
  const m = /^([A-Z]+)\s+(\S+)\s+(HTTP\/\d(?:\.\d)?)$/.exec(lines[0]);
  if (!m) return null;
  const headers = [];
  const headerMap = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const ci = line.indexOf(':');
    if (ci === -1) continue;
    const name = line.slice(0, ci).trim();
    const value = line.slice(ci + 1).trim();
    headers.push([name, value]);
    headerMap[name.toLowerCase()] = value;
  }
  return { headEnd: idx + 4, method: m[1], target: m[2], version: m[3], headers, headerMap };
}

/** Decode a chunked body starting at `start`. Null if incomplete. */
function decodeChunked(buf, start) {
  let pos = start;
  const chunks = [];
  let total = 0;
  for (;;) {
    const lineEnd = buf.indexOf('\r\n', pos);
    if (lineEnd === -1) return null;
    const sizeLine = buf.subarray(pos, lineEnd).toString('latin1');
    const size = parseInt(sizeLine.split(';')[0].trim(), 16);
    if (Number.isNaN(size)) return { error: 'bad chunk size' };
    pos = lineEnd + 2;
    if (size === 0) {
      // Consume optional trailer lines until the terminating empty line.
      for (;;) {
        const tEnd = buf.indexOf('\r\n', pos);
        if (tEnd === -1) return null;
        if (tEnd === pos) return { body: Buffer.concat(chunks), end: tEnd + 2 };
        pos = tEnd + 2;
      }
    }
    if (buf.length < pos + size + 2) return null;
    chunks.push(buf.subarray(pos, pos + size));
    total += size;
    if (total > MAX_REQUEST_BODY) return { error: 'request body too large' };
    pos += size + 2;
  }
}

/** Determine the request body. Returns {pending} while incomplete. */
function extractBody(buf, parsed) {
  const te = parsed.headerMap['transfer-encoding'];
  const cl = parsed.headerMap['content-length'];
  if (te && /chunked/i.test(te)) {
    const r = decodeChunked(buf, parsed.headEnd);
    if (!r) return { pending: true };
    if (r.error) return { error: r.error };
    return { body: r.body, end: r.end, source: 'chunked' };
  }
  if (cl !== undefined) {
    const n = parseInt(cl, 10);
    if (Number.isNaN(n) || n < 0) return { error: 'bad content-length' };
    if (n > MAX_REQUEST_BODY) return { error: 'request body too large' };
    if (buf.length < parsed.headEnd + n) return { pending: true };
    return {
      body: buf.subarray(parsed.headEnd, parsed.headEnd + n),
      end: parsed.headEnd + n,
      source: 'content-length',
    };
  }
  return { body: Buffer.alloc(0), end: parsed.headEnd, source: 'none' };
}

function cleanHeaders(headerMap, { keepLength } = {}) {
  const out = {};
  for (const [name, value] of Object.entries(headerMap)) {
    if (HOP_BY_HOP.has(name)) continue;
    if (name === 'content-length' && !keepLength) continue;
    out[name] = value;
  }
  return out;
}

function shouldKeepAlive(parsed) {
  const conn = parsed.headerMap['connection'] || '';
  if (parsed.version === 'HTTP/1.1') return !/close/i.test(conn);
  return /keep-alive/i.test(conn);
}

// ------------------------------------------------------------------ writing

function writeRawResponse(socket, status, reason, headers, body) {
  const lines = [`HTTP/1.1 ${status} ${reason || http.STATUS_CODES[status] || ''}`];
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const v of value) lines.push(`${name}: ${v}`);
    } else {
      lines.push(`${name}: ${value}`);
    }
  }
  socket.write(lines.join('\r\n') + '\r\n\r\n');
  if (body && body.length) socket.write(body);
}

function writeUpstreamResponse(client, upRes, body, { head }) {
  const headers = cleanHeaders(upRes.headers, { keepLength: false });
  if (upRes.statusCode !== 204 && upRes.statusCode !== 304 && head !== 'HEAD') {
    headers['content-length'] = body.length;
  }
  writeRawResponse(client, upRes.statusCode, upRes.statusMessage, headers, body);
}

// ------------------------------------------------------------------ handlers

function rawPipe(clientSocket, target, head) {
  const upstream = net.connect(target.port, target.host);
  upstream.on('connect', () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on('error', (err) => {
    try {
      clientSocket.destroy(err);
    } catch {
      /* ignore */
    }
  });
  clientSocket.on('error', () => upstream.destroy());
  // Close must propagate both ways; the http server does not always surface
  // client disconnects on hijacked sockets, so hook close/end explicitly.
  clientSocket.on('close', () => upstream.destroy());
  clientSocket.on('end', () => upstream.destroy());
}

function handleTunnel({ clientSocket, host, port, head, ca, inspector, logger, upstream = {}, interceptPorts }) {
  const ports = interceptPorts && interceptPorts.length ? interceptPorts : [443];
  if (!ports.includes(port)) {
    rawPipe(clientSocket, { host, port }, head);
    return;
  }

  const cert = getHostCertificate(ca, host);
  let secureContext;
  try {
    secureContext = tls.createSecureContext({ key: cert.key, cert: cert.cert });
  } catch (err) {
    logger.error(`[mitm] cert setup failed for ${host}: ${err.message}`);
    clientSocket.destroy();
    return;
  }

  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

  // If the client pipelined bytes after CONNECT (rare), push them back into the
  // stream so the TLS handshake sees them.
  if (head && head.length) clientSocket.unshift(head);

  const client = new tls.TLSSocket(clientSocket, { isServer: true, secureContext });
  client.on('error', () => clientSocket.destroy());

  // Watch the raw socket too: Node's http server does not always propagate
  // client disconnects through a hijacked + TLS-wrapped socket, which would
  // leak the connection (and block server.close()). Force-destroy the TLS
  // side when the underlying socket signals end/close/error.
  const forceDestroy = () => {
    try {
      client.destroy();
    } catch {
      /* ignore */
    }
  };
  clientSocket.on('close', forceDestroy);
  clientSocket.on('end', forceDestroy);
  clientSocket.on('error', forceDestroy);

  // Start the relay immediately: in server mode a TLSSocket only completes the
  // handshake while the underlying socket is flowing (a 'data' listener attached
  // up front). Decrypted app data cannot arrive before 'secureConnect', so
  // pumping early is safe.
  relayLoop(client, host, port, ca, inspector, logger, upstream);
}

/**
 * Serialized request/response relay over an established client TLS socket.
 * Requests are processed one at a time (`busy` flag); keep-alive is honoured.
 * `upstream` = { ca, rejectUnauthorized } for the upstream (egress) TLS leg.
 */
function relayLoop(client, host, port, ca, inspector, logger, upstream = {}) {
  let clientBuffer = Buffer.alloc(0);
  let busy = false;
  let closed = false;
  let secureReady = false;
  let upstreamReq = null;
  let upstreamRaw = null;

  function closeAll() {
    if (closed) return;
    closed = true;
    if (upstreamReq) upstreamReq.destroy();
    if (upstreamRaw) upstreamRaw.destroy();
    try {
      client.destroy();
    } catch {
      /* ignore */
    }
  }

  function pump() {
    if (!secureReady || busy || closed) return;
    const parsed = parseHead(clientBuffer);
    if (!parsed) return;
    const bodyInfo = extractBody(clientBuffer, parsed);
    if (bodyInfo.pending) return;
    if (bodyInfo.error) {
      writeRawResponse(client, 400, 'Bad Request', { 'content-length': 0, connection: 'close' }, '');
      return closeAll();
    }
    busy = true;
    handleRequest(parsed, bodyInfo);
  }

  client.on('data', (chunk) => {
    clientBuffer = Buffer.concat([clientBuffer, chunk]);
    pump();
  });
  client.on('close', closeAll);
  client.on('error', closeAll);
  // Server-side TLSSocket emits 'secure' (not 'secureConnect') when the
  // handshake completes. TLSSocket only delivers decrypted application data
  // after that point, so pumping from the data handler alone is also safe.
  client.on('secure', () => {
    secureReady = true;
    logger.info(`[mitm] TLS established with client for ${host}`);
    pump();
  });
  client.resume(); // flowing mode: required for the server handshake to complete

  async function handleRequest(parsed, bodyInfo) {
    const ctx = {
      host,
      port,
      method: parsed.method,
      target: parsed.target,
      headers: parsed.headerMap,
      rawHeaders: parsed.headers,
      body: bodyInfo.body,
      protocol: 'https',
    };

    // WebSocket / Upgrade: hand the raw bytes through a bidirectional pipe.
    if (/upgrade/i.test(parsed.headerMap['upgrade'] || '')) {
      const raw = clientBuffer.subarray(0, bodyInfo.end);
      clientBuffer = Buffer.alloc(0);
      upstreamRaw = tls.connect({
        host,
        port,
        servername: host,
        rejectUnauthorized: upstream.rejectUnauthorized !== false,
        ca: upstream.ca,
      });
      upstreamRaw.on('secureConnect', () => {
        upstreamRaw.write(raw);
        upstreamRaw.pipe(client);
        client.pipe(upstreamRaw);
      });
      upstreamRaw.on('error', closeAll);
      return;
    }

    let decision;
    try {
      decision = await inspector.inspectRequest(ctx);
    } catch (err) {
      logger.error(`[mitm] inspector error: ${err.message}`);
      decision = inspector.failOpen
        ? { action: 'pass' }
        : { action: 'block', status: 403, body: 'Filter error; request blocked.', reason: 'inspector-error' };
    }

    inspector.recordDecision({ ...decision, method: parsed.method, host, target: parsed.target });

    if (decision.action === 'block') {
      const body = Buffer.isBuffer(decision.body)
        ? decision.body
        : Buffer.from(decision.body || 'Blocked by itqan Shield');
      writeRawResponse(client, decision.status || 403, undefined, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': body.length,
        connection: 'close',
        ...(decision.headers || {}),
      }, body);
      clientBuffer = Buffer.alloc(0);
      // Graceful close: flush the response, then send close_notify. destroy()
      // here would drop the unflushed 403 from the client's perspective.
      client.end();
      return;
    }

    // --- forward upstream
    const headers = cleanHeaders(parsed.headerMap);
    headers['content-length'] = bodyInfo.body.length;
    headers.connection = 'close'; // one request per upstream connection for M1

    upstreamReq = https.request({
      host,
      port,
      method: parsed.method,
      path: parsed.target,
      headers,
      servername: host,
      rejectUnauthorized: upstream.rejectUnauthorized !== false,
      ca: upstream.ca,
      timeout: UPSTREAM_TIMEOUT,
    });

    upstreamReq.on('timeout', () => {
      logger.warn(`[mitm] upstream timeout for ${host}`);
      upstreamReq.destroy(new Error('upstream timeout'));
    });

    upstreamReq.on('error', (err) => {
      logger.warn(`[mitm] upstream error for ${host}: ${err.message}`);
      writeRawResponse(client, 502, 'Bad Gateway', { 'content-length': 0, connection: 'close' }, '');
      client.end();
    });

    upstreamReq.on('response', (upRes) => {
      const chunks = [];
      let total = 0;
      let aborted = false;
      upRes.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BODY) {
          aborted = true;
          upRes.destroy();
          writeRawResponse(client, 502, 'Bad Gateway', { 'content-length': 0, connection: 'close' }, '');
          return client.end();
        }
        chunks.push(chunk);
      });
      upRes.on('end', () => {
        if (aborted) return;
        const body = Buffer.concat(chunks);
        writeUpstreamResponse(client, upRes, body, { head: parsed.method });
        finishRequest();
      });
      upRes.on('error', closeAll);
    });

    if (bodyInfo.body.length) upstreamReq.write(bodyInfo.body);
    upstreamReq.end();
  }

  function finishRequest() {
    const consumed = extractBody(clientBuffer, parseHead(clientBuffer)).end;
    clientBuffer = clientBuffer.subarray(consumed);
    busy = false;
    const parsed = parseHead(clientBuffer);
    if (parsed && !shouldKeepAlive(parsed)) {
      client.end();
      return;
    }
    pump();
  }
}

module.exports = {
  handleTunnel,
  // Internal helpers exported for the unit test suite.
  parseHead,
  decodeChunked,
  extractBody,
  cleanHeaders,
  shouldKeepAlive,
};
