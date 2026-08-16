'use strict';

/**
 * Proxy server wiring: plain-HTTP passthrough + CONNECT interception.
 * Binds to 127.0.0.1 only — never exposed to the network.
 */

const http = require('http');
const { URL } = require('url');
const { loadOrCreateCA } = require('./ca');
const { handleTunnel } = require('./mitm');
const { createInspector } = require('./inspect');

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

function handlePlainHttp(req, res, logger) {
  let url;
  try {
    url = new URL(req.url, 'http://placeholder');
  } catch {
    res.writeHead(400, { 'content-length': 0 });
    return res.end();
  }
  const host = url.hostname;
  const port = url.port || 80;

  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(name)) continue;
    headers[name] = value;
  }
  headers.host = url.host;

  const upstream = http.request(
    { host, port, method: req.method, path: url.pathname + url.search, headers },
    (upRes) => {
      const resHeaders = {};
      for (const [name, value] of Object.entries(upRes.headers)) {
        if (HOP_BY_HOP.has(name)) continue;
        resHeaders[name] = value;
      }
      res.writeHead(upRes.statusCode, resHeaders);
      upRes.pipe(res);
    }
  );
  upstream.on('error', (err) => {
    logger.warn(`[proxy] plain-http upstream error for ${host}: ${err.message}`);
    try {
      res.writeHead(502, { 'content-length': 0 });
      res.end();
    } catch {
      /* ignore */
    }
  });
  req.pipe(upstream);
}

/**
 * Start the local proxy.
 *
 * @param {object} opts
 * @param {number} opts.port listen port (0 = ephemeral)
 * @param {string} opts.dataDir CA/data directory
 * @param {object} [opts.logger]
 * @param {object} [opts.inspector] filter seam (see inspect.js)
 * @param {number} [opts.maxRetries]
 * @param {object} [opts.upstream] upstream (egress) TLS leg options:
 *   { ca?: string|Buffer, rejectUnauthorized?: boolean } — default verifies
 *   against the public PKI. `ca` lets enterprise deployments inspect egress
 *   against a private CA (also used by the test suite).
 * @param {number[]} [opts.interceptPorts] CONNECT ports that get TLS
 *   interception. Default [443]. Other ports are raw-tunneled.
 * @returns {Promise<{ server, ca, port, stop }>} — resolves once listening.
 */
function startProxy({ port, dataDir, logger, inspector, maxRetries = 20, upstream = {}, interceptPorts }) {
  const log = logger || console;
  const ca = loadOrCreateCA(dataDir);
  const insp = inspector || createInspector({ logger: log });

  const server = http.createServer((req, res) => handlePlainHttp(req, res, log));

  // Track every accepted socket ourselves: Node's http server does not reliably
  // observe close on CONNECT-hijacked sockets wrapped in a TLSSocket, which
  // would make server.close() hang. We force-destroy these on stop().
  const sockets = new Set();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => sockets.delete(s));
  });

  server.on('connect', (req, clientSocket, head) => {
    const [host, portStr] = req.url.split(':');
    const targetPort = parseInt(portStr, 10);
    if (!host || Number.isNaN(targetPort)) {
      clientSocket.destroy();
      return;
    }
    handleTunnel({
      clientSocket,
      host,
      port: targetPort,
      head,
      ca,
      inspector: insp,
      logger: log,
      upstream,
      interceptPorts,
    });
  });
  server.on('clientError', (err, socket) => {
    log.debug(`[proxy] client error: ${err.message}`);
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch {
      /* ignore */
    }
  });

  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tryListen = () => {
      const p = port + attempts;
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempts < maxRetries) {
          attempts += 1;
          log.warn(`[proxy] port ${p} busy, trying ${port + attempts}`);
          tryListen();
        } else {
          reject(err);
        }
      });
      server.listen(p, '127.0.0.1', () => {
        const actual = server.address().port;
        log.info(`[proxy] listening on 127.0.0.1:${actual}`);
        resolve({
          server,
          ca,
          port: actual,
          stop: () =>
            new Promise((res) => {
              let settled = false;
              const done = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                res();
              };
              // Hard fallback: quitting must never hang on a stuck socket.
              const timer = setTimeout(() => {
                for (const s of sockets) {
                  try {
                    s.destroy();
                  } catch {
                    /* ignore */
                  }
                }
                done();
              }, 1500);
              if (timer.unref) timer.unref();

              for (const s of sockets) {
                try {
                  s.destroy();
                } catch {
                  /* ignore */
                }
              }
              server.close(done);
              server.closeAllConnections?.();
              server.closeIdleConnections?.();
            }),
        });
      });
    };
    tryListen();
  });
}

module.exports = { startProxy };
