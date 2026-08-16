'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const { tmpDataDir } = require('./helpers');

const ROOT = path.resolve(__dirname, '..');

function runCli(args) {
  return spawnSync('node', [path.join('src', 'proxy', 'index.js'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
  });
}

test('CLI: --status prints data dir and CA path', () => {
  const dir = tmpDataDir();
  const r = runCli(['--status', '--data-dir', dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /itqan Shield proxy status/);
  assert.match(r.stdout, /CA cert/);
});

test('CLI: --help lists the options', () => {
  const r = runCli(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--install-ca/);
  assert.match(r.stdout, /--proxy-on/);
  assert.match(r.stdout, /--status/);
});

test('CLI: unknown option exits non-zero', () => {
  const r = runCli(['--bogus']);
  assert.notEqual(r.status, 0);
});

test('CLI: --install-ca on Linux fails gracefully with guidance', (t) => {
  if (process.platform !== 'linux') return t.skip('linux-only behaviour');
  const dir = tmpDataDir();
  const r = runCli(['--install-ca', '--data-dir', dir]);
  assert.notEqual(r.status, 0, 'must exit non-zero');
  assert.match(r.stderr + r.stdout, /Failed/);
});
