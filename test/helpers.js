'use strict';

/**
 * Shared test helpers: quiet logger, temp dirs, test CAs, upstream servers,
 * and a raw HTTP/1.1 client that speaks to the proxy through the MITM tunnel.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');
const forge = require('node-forge');

const quietLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shield-test-'));
}

/**
 * Generate a throwaway CA + a leaf certificate for `localhost` (RSA-2048).
 * Returns PEM strings. Used as the upstream (egress) server certificate and
 * to verify the proxy's own MITM leaf certificates.
 */
function makeTestPki() {
  const caKeys = forge.pki.rsa.generateKeyPair(2048);
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = 'AB' + forge.util.bytesToHex(forge.random.getBytesSync(8));
  caCert.validity.notBefore = new Date(Date.now() - 3600e3);
  caCert.validity.notAfter = new Date(Date.now() + 86400e6);
  const caAttrs = [{ name: 'commonName', value: 'shield test CA' }];
  caCert.setSubject(caAttrs);
  caCert.setIssuer(caAttrs);
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
  ]);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());
  const caPem = forge.pki.certificateToPem(caCert);

  const srvKeys = forge.pki.rsa.generateKeyPair(2048);
  const srvCert = forge.pki.createCertificate();
  srvCert.publicKey = srvKeys.publicKey;
  srvCert.serialNumber = 'CD' + forge.util.bytesToHex(forge.random.getBytesSync(8));
  srvCert.validity.notBefore = new Date(Date.now() - 3600e3);
  srvCert.validity.notAfter = new Date(Date.now() + 86400e6);
  srvCert.setSubject([{ name: 'commonName', value: 'localhost' }]);
  srvCert.setIssuer(
    caCert.subject.attributes.map((a) => ({ name: a.name || a.shortName, value: a.value }))
  );
  srvCert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] },
  ]);
  srvCert.sign(caKeys.privateKey, forge.md.sha256.create());

  return {
    caPem,
    certPem: forge.pki.certificateToPem(srvCert),
    keyPem: forge.pki.privateKeyToPem(srvKeys.privateKey),
  };
}

/** A test upstream that records every request it receives. */
function makeUpstream({ tls: useTls, pki } = {}) {
  const requests = [];
  const handler = (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
        bodyText: body.toString('utf8'),
      });
      route(req, res, body);
    });
  };

  function route(req, res, body) {
    const url = req.url.split('?')[0];
    if (url === '/sse') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const events = ['data: first\n\n', 'data: second\n\n', 'data: third\n\n'];
      let i = 0;
      const timer = setInterval(() => {
        res.write(events[i]);
        i += 1;
        if (i === events.length) {
          clearInterval(timer);
          res.end();
        }
      }, 15);
      return;
    }
    if (url === '/big') {
      const payload = Buffer.alloc(1024 * 1024, 'x');
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(payload);
      return;
    }
    if (url === '/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('slow-response');
      }, 300);
      return;
    }
    const payload = JSON.stringify({ method: req.method, url: req.url, body: body.toString('utf8') });
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  return new Promise((resolve) => {
    const server = useTls
      ? https.createServer({ key: pki.keyPem, cert: pki.certPem }, handler)
      : http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, requests });
    });
  });
}

/** Minimal HTTP/1.1 response parser (proxy always sends Content-Length). */
function parseHttpResponse(buf) {
  const idx = buf.indexOf('\r\n\r\n');
  if (idx === -1) return null;
  const head = buf.subarray(0, idx).toString('latin1');
  const lines = head.split('\r\n');
  const statusLine = /^HTTP\/1\.1 (\d{3})(?: (.*))?$/.exec(lines[0]);
  if (!statusLine) return null;
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const ci = lines[i].indexOf(':');
    if (ci === -1) continue;
    const k = lines[i].slice(0, ci).trim().toLowerCase();
    const v = lines[i].slice(ci + 1).trim();
    headers[k] = headers[k] ? `${headers[k]}, ${v}` : v;
  }
  if (headers['content-length'] === undefined) {
    return { status: Number(statusLine[1]), headers, body: Buffer.alloc(0), headEnd: idx + 4 };
  }
  const cl = parseInt(headers['content-length'], 10);
  if (buf.length < idx + 4 + cl) return null;
  return {
    status: Number(statusLine[1]),
    headers,
    body: buf.subarray(idx + 4, idx + 4 + cl),
    headEnd: idx + 4,
  };
}

/**
 * Raw client that opens a CONNECT tunnel through the proxy and speaks
 * HTTP/1.1 over the intercepted TLS. One instance = one connection
 * (supports keep-alive: multiple `request()` calls).
 */
class MitmClient {
  constructor({ proxyPort, targetHost = 'localhost', targetPort, caPem, tlsRejectUnauthorized = true }) {
    this.proxyPort = proxyPort;
    this.targetHost = targetHost;
    this.targetPort = targetPort;
    this.caPem = caPem;
    this.tlsRejectUnauthorized = tlsRejectUnauthorized;
    this.buffer = Buffer.alloc(0);
    this.pending = [];
    this.tls = null;
    this.connected = false;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const self = this;
      const raw = net.connect(this.proxyPort, '127.0.0.1');
      raw.on('error', reject);
      raw.write(
        `CONNECT ${this.targetHost}:${this.targetPort} HTTP/1.1\r\n` +
          `Host: ${this.targetHost}:${this.targetPort}\r\n\r\n`
      );
      let plain = Buffer.alloc(0);
      raw.on('data', function onPlain(d) {
        plain = Buffer.concat([plain, d]);
        if (plain.includes('\r\n\r\n')) {
          raw.removeListener('data', onPlain);
          const head = plain.toString('latin1').split('\r\n')[0];
          if (!head.includes('200')) {
            reject(new Error(`CONNECT failed: ${head}`));
            return;
          }
          const tlsSock = tls.connect({
            socket: raw,
            servername: self.targetHost,
            ca: self.caPem,
            rejectUnauthorized: self.tlsRejectUnauthorized,
          });
          self.tls = tlsSock;
          tlsSock.on('secureConnect', () => {
            self.connected = true;
            tlsSock.on('data', (chunk) => {
              self.buffer = Buffer.concat([self.buffer, chunk]);
              self._drain();
            });
            tlsSock.on('error', () => {});
            tlsSock.on('close', () => {
              self.closed = true;
              self._drain();
            });
            resolve();
          });
          tlsSock.on('error', reject);
        }
      });
    });
  }

  _drain() {
    while (this.pending.length) {
      const p = this.pending[0];
      const parsed = parseHttpResponse(this.buffer);
      if (!parsed) {
        if (this.closed && p.onClose) p.onClose();
        else if (this.closed) p.reject(new Error('connection closed before full response'));
        else return;
      } else {
        this.buffer = this.buffer.subarray(parsed.headEnd + parsed.body.length);
        this.pending.shift();
        p.resolve(parsed);
      }
    }
  }

  /**
   * Send one request over the tunnel.
   * @param {object} opts { method, path, headers, body, chunked }
   *   body: string|Buffer → Content-Length framing
   *   chunked: string → Transfer-Encoding: chunked framing (proxy must decode)
   */
  request(opts = {}) {
    const { method = 'GET', path = '/', headers = {}, body = null, chunked = null } = opts;
    let head = `${method} ${path} HTTP/1.1\r\nHost: ${this.targetHost}\r\n`;
    let payload = Buffer.alloc(0);
    if (chunked !== null) {
      head += 'Transfer-Encoding: chunked\r\n';
      const chunks = [];
      for (const part of chunked.split('|')) {
        const b = Buffer.from(part, 'utf8');
        chunks.push(Buffer.from(b.length.toString(16) + '\r\n'), b, Buffer.from('\r\n'));
      }
      chunks.push(Buffer.from('0\r\n\r\n'));
      payload = Buffer.concat(chunks);
    } else if (body !== null) {
      const b = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
      head += `Content-Length: ${b.length}\r\n`;
      payload = b;
    }
    for (const [k, v] of Object.entries(headers)) head += `${k}: ${v}\r\n`;
    head += '\r\n';

    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.tls.write(Buffer.concat([Buffer.from(head, 'latin1'), payload]));
    });
  }

  close() {
    if (this.tls) this.tls.destroy();
  }
}

module.exports = {
  quietLogger,
  tmpDataDir,
  makeTestPki,
  makeUpstream,
  parseHttpResponse,
  MitmClient,
};
