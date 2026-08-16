'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const forge = require('node-forge');
const { loadOrCreateCA, getHostCertificate, CA_CN } = require('../src/proxy/ca');
const { tmpDataDir } = require('./helpers');

test('CA is created on first run and reloads identically', () => {
  const dir = tmpDataDir();
  const ca = loadOrCreateCA(dir);
  assert.ok(ca.cert, 'has parsed cert');
  assert.ok(ca.key, 'has private key');
  assert.equal(ca.cert.subject.getField('CN').value, CA_CN);

  const p = ca.paths;
  assert.ok(fs.existsSync(p.cert), 'ca.pem written');
  assert.ok(fs.existsSync(p.key), 'ca.key written');

  // Reload must round-trip to the same key material.
  const reloaded = loadOrCreateCA(dir);
  assert.equal(
    forge.pki.privateKeyToPem(reloaded.key),
    forge.pki.privateKeyToPem(ca.key),
    'reloaded CA key matches'
  );
});

test('CA files have restrictive permissions', () => {
  const dir = tmpDataDir();
  const ca = loadOrCreateCA(dir);
  const keyMode = fs.statSync(ca.paths.key).mode & 0o777;
  const certMode = fs.statSync(ca.paths.cert).mode & 0o777;
  assert.equal(keyMode, 0o600, 'private key must be 0600');
  assert.equal(certMode, 0o644, 'certificate is public data (0644)');
});

test('leaf certs are signed by the CA and chain-verify', () => {
  const dir = tmpDataDir();
  const ca = loadOrCreateCA(dir);

  for (const host of ['api.openai.com', 'chatgpt.com', '127.0.0.1']) {
    const entry = getHostCertificate(ca, host);
    const leaf = forge.pki.certificateFromPem(entry.cert);

    // Issuer DN must equal the CA subject DN byte-for-byte.
    const caSubject = forge.asn1
      .toDer(forge.pki.distinguishedNameToAsn1(ca.cert.subject))
      .toHex();
    const leafIssuer = forge.asn1
      .toDer(forge.pki.distinguishedNameToAsn1(leaf.issuer))
      .toHex();
    assert.equal(leafIssuer, caSubject, `issuer DN matches CA subject for ${host}`);

    // Real-world verification with OpenSSL — the verifier every TLS client
    // (Node, Electron, browsers) uses.
    fs.writeFileSync(path.join(dir, 'verify-ca.pem'), fs.readFileSync(ca.paths.cert));
    fs.writeFileSync(path.join(dir, 'verify-leaf.pem'), entry.cert);
    const out = execFileSync('openssl', ['verify', '-CAfile', path.join(dir, 'verify-ca.pem'), path.join(dir, 'verify-leaf.pem')], {
      encoding: 'utf8',
    });
    assert.match(out, /OK/, `openssl verify accepts ${host}`);

    // SAN must cover the host.
    const san = leaf.getExtension('subjectAltName');
    assert.ok(san, 'has subjectAltName');
    const names = (san.altNames || []).map((n) => (n.type === 7 || n.ip ? String(n.ip) : n.value));
    assert.ok(names.includes(host), `SAN covers ${host} (got ${names.join(',')})`);
    assert.equal(leaf.subject.getField('CN').value, host);
  }
});

test('leaf certs are cached (same PEM returned without re-minting)', () => {
  const dir = tmpDataDir();
  const ca = loadOrCreateCA(dir);
  const a = getHostCertificate(ca, 'api.anthropic.com');
  const b = getHostCertificate(ca, 'api.anthropic.com');
  assert.equal(a.cert, b.cert, 'cached cert PEM identical');
  assert.equal(a.key, b.key, 'cached key PEM identical');
});

test('leaf certs are unique per host', () => {
  const dir = tmpDataDir();
  const ca = loadOrCreateCA(dir);
  const a = getHostCertificate(ca, 'host-a.example');
  const b = getHostCertificate(ca, 'host-b.example');
  assert.notEqual(a.cert, b.cert);
});

test('leaf certs persist across reloads (disk cache)', () => {
  const dir = tmpDataDir();
  const ca = loadOrCreateCA(dir);
  const first = getHostCertificate(ca, 'persist.example');
  const ca2 = loadOrCreateCA(dir);
  const second = getHostCertificate(ca2, 'persist.example');
  assert.equal(first.cert, second.cert, 'disk-cached leaf survives CA reload');
});

test('leaf key files are 0600', () => {
  const dir = tmpDataDir();
  const ca = loadOrCreateCA(dir);
  getHostCertificate(ca, 'secure.example');
  const files = fs.readdirSync(ca.paths.certsDir).filter((f) => f.endsWith('.key'));
  assert.ok(files.length > 0);
  for (const f of files) {
    assert.equal(fs.statSync(path.join(ca.paths.certsDir, f)).mode & 0o777, 0o600);
  }
});
