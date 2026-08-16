'use strict';

/**
 * Local certificate authority for TLS interception.
 *
 * - A single root CA ("itqan Shield Local CA") is generated once per device
 *   and stored under the data directory. The CA never leaves the device.
 * - Per-host leaf certificates are minted on demand, signed by that CA, and
 *   cached on disk so repeated visits are cheap.
 *
 * Uses node-forge (pure JS) so there is no native build step and the cert
 * store is fully under our control.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const forge = require('node-forge');

const CA_CN = 'itqan Shield Local CA';
const CA_DAYS = 3650; // 10 years
const HOST_CERT_DAYS = 400; // comfortably inside Apple's 398-day window

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function caPaths(dataDir) {
  return {
    dir: dataDir,
    cert: path.join(dataDir, 'ca.pem'),
    key: path.join(dataDir, 'ca.key'),
    certsDir: path.join(dataDir, 'certs'),
  };
}

function generateCA(dataDir) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = crypto.randomBytes(10).toString('hex');
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + CA_DAYS * 86400 * 1000);

  const attrs = [
    { name: 'commonName', value: CA_CN },
    { name: 'organizationName', value: 'itqan' },
    { name: 'organizationalUnitName', value: 'itqan Shield' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const pemCert = forge.pki.certificateToPem(cert);
  const pemKey = forge.pki.privateKeyToPem(keys.privateKey);

  const p = caPaths(dataDir);
  mkdirp(dataDir);
  mkdirp(p.certsDir);
  fs.writeFileSync(p.cert, pemCert, { mode: 0o644 });
  fs.writeFileSync(p.key, pemKey, { mode: 0o600 });

  return { cert, key: keys.privateKey, paths: p };
}

function loadCA(dataDir) {
  const p = caPaths(dataDir);
  if (!fs.existsSync(p.cert) || !fs.existsSync(p.key)) return null;
  try {
    const cert = forge.pki.certificateFromPem(fs.readFileSync(p.cert, 'utf8'));
    const key = forge.pki.privateKeyFromPem(fs.readFileSync(p.key, 'utf8'));
    return { cert, key, paths: p };
  } catch (err) {
    return null;
  }
}

/** Load the CA or create it on first run. */
function loadOrCreateCA(dataDir) {
  return loadCA(dataDir) || generateCA(dataDir);
}

const certCache = new Map();

function cacheKey(ca, host) {
  // Leaves are only valid for the CA that signed them — key the cache by CA
  // identity (serial) plus host so a new CA never reuses stale leaves.
  return `${ca.cert.serialNumber}:${host}`;
}

function hostCertPaths(ca, host) {
  const digest = crypto.createHash('sha1').update(host).digest('hex');
  return {
    cert: path.join(ca.paths.certsDir, `${digest}.pem`),
    key: path.join(ca.paths.certsDir, `${digest}.key`),
  };
}

/**
 * Mint (or load from cache) a leaf certificate for `host`, signed by the CA.
 * Returns { cert, key } PEM strings suitable for tls.createSecureContext.
 */
function getHostCertificate(ca, host) {
  const key = cacheKey(ca, host);
  if (certCache.has(key)) return certCache.get(key);

  const p = hostCertPaths(ca, host);
  if (fs.existsSync(p.cert) && fs.existsSync(p.key)) {
    const entry = {
      cert: fs.readFileSync(p.cert, 'utf8'),
      key: fs.readFileSync(p.key, 'utf8'),
    };
    certCache.set(key, entry);
    return entry;
  }

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = crypto.randomBytes(10).toString('hex');
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + HOST_CERT_DAYS * 86400 * 1000);

  cert.setSubject([{ name: 'commonName', value: host }]);
  // Rebuild the issuer from plain attributes: copying the CA's normalized
  // attribute objects would carry a valueTagClass that changes the DER
  // encoding of the DN (UTF8String vs PrintableString), which breaks
  // byte-exact chain verification (forge hashes DNs from the DER).
  cert.setIssuer(
    ca.cert.subject.attributes.map((a) => ({ name: a.name || a.shortName, value: a.value }))
  );
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: net.isIP(host) ? [{ type: 7, ip: host }] : [{ type: 2, value: host }],
    },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());

  const entry = {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };
  certCache.set(cacheKey(ca, host), entry);

  mkdirp(ca.paths.certsDir);
  fs.writeFileSync(p.cert, entry.cert, { mode: 0o644 });
  fs.writeFileSync(p.key, entry.key, { mode: 0o600 });
  return entry;
}

module.exports = {
  CA_CN,
  loadOrCreateCA,
  getHostCertificate,
  caPaths,
};
