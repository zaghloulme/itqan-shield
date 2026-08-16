'use strict';

/**
 * OS trust-store integration for the local CA.
 * Shared by the headless CLI (src/proxy/index.js) and the Electron app.
 *
 * Windows: certutil into the per-user Root store (no admin).
 * macOS:   security add-trusted-cert into the login keychain (may prompt/admin).
 * Linux:   documented manual path (dev/testing only).
 */

const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { loadOrCreateCA, CA_CN } = require('./ca');

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function installCa(dataDir, logger = console) {
  const ca = loadOrCreateCA(dataDir);
  if (process.platform === 'darwin') {
    const keychain = path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db');
    const r = await run('security', ['add-trusted-cert', '-d', '-r', 'trustRoot', '-k', keychain, ca.paths.cert]);
    if (r.err) {
      return {
        ok: false,
        error: r.stderr.trim() || r.err.message,
        hint: 'macOS may require admin rights. Try: sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ' + ca.paths.cert,
      };
    }
    return { ok: true, message: 'CA installed ✓ (login keychain, trust root)' };
  }
  if (process.platform === 'win32') {
    const r = await run('certutil', ['-addstore', '-user', 'Root', ca.paths.cert]);
    if (r.err) {
      return { ok: false, error: r.stderr.trim() || r.err.message };
    }
    return { ok: true, message: 'CA installed ✓ (user Root store). Restart browsers to pick it up.' };
  }
  return {
    ok: false,
    error: `No OS trust store integration for ${process.platform}`,
    hint: `Manual trust (Linux dev/testing): sudo cp ${ca.paths.cert} /usr/local/share/ca-certificates/itqan-shield.crt && sudo update-ca-certificates`,
  };
}

async function uninstallCa(dataDir, logger = console) {
  const ca = loadOrCreateCA(dataDir);
  if (process.platform === 'darwin') {
    const r = await run('security', ['delete-certificate', '-c', CA_CN]);
    if (r.err) return { ok: false, error: r.stderr.trim() || r.err.message };
    return { ok: true, message: 'CA removed ✓' };
  }
  if (process.platform === 'win32') {
    const r = await run('certutil', ['-delstore', '-user', 'Root', CA_CN]);
    if (r.err) return { ok: false, error: r.stderr.trim() || r.err.message };
    return { ok: true, message: 'CA removed ✓' };
  }
  return {
    ok: false,
    error: `No OS trust store integration for ${process.platform}`,
    hint: `Remove manually: sudo rm /usr/local/share/ca-certificates/itqan-shield.crt && sudo update-ca-certificates`,
  };
}

module.exports = { installCa, uninstallCa };
