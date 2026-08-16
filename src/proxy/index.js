#!/usr/bin/env node
'use strict';

/**
 * itqan Shield proxy — headless CLI.
 *
 * Runs the local MITM proxy without the Electron UI, so the core can be
 * developed and verified on any machine (Linux included) before the desktop
 * shell is wired up.
 *
 * Usage:
 *   node src/proxy/index.js [options]
 *
 * Options:
 *   --port N          listen port (default 8080; auto-increments if busy)
 *   --data-dir DIR    data directory (default ~/.itqan-shield)
 *   --install-ca      install the local CA into the OS trust store, then exit
 *   --uninstall-ca    remove the local CA from the OS trust store, then exit
 *   --proxy-on        enable the OS system proxy (127.0.0.1:<port>), then exit
 *   --proxy-off       disable the OS system proxy (restores prior state), then exit
 *   --status          print status, then exit
 *   --quiet           only warnings and errors
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { loadOrCreateCA, CA_CN } = require('./ca');
const { startProxy } = require('./server');
const { installCa, uninstallCa } = require('./ca-trust');
const {
  enableSystemProxy,
  disableSystemProxy,
  getSystemProxyState,
} = require('./system-proxy');

const DEFAULT_PORT = 8080;
const DEFAULT_DATA_DIR = path.join(os.homedir(), '.itqan-shield');

const logger = {
  debug: () => {},
  info: (msg) => {
    if (!quiet) console.log(msg);
  },
  warn: (msg) => console.warn(`\x1b[33m${msg}\x1b[0m`),
  error: (msg) => console.error(`\x1b[31m${msg}\x1b[0m`),
};
let quiet = false;

function parseArgs(argv) {
  const args = {
    port: DEFAULT_PORT,
    dataDir: process.env.SHIELD_DATA_DIR || DEFAULT_DATA_DIR,
    action: 'run',
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--port':
        args.port = parseInt(argv[++i], 10);
        break;
      case '--data-dir':
        args.dataDir = argv[++i];
        break;
      case '--upstream-ca':
        args.upstreamCa = argv[++i];
        break;
      case '--install-ca':
        args.action = 'install-ca';
        break;
      case '--uninstall-ca':
        args.action = 'uninstall-ca';
        break;
      case '--proxy-on':
        args.action = 'proxy-on';
        break;
      case '--proxy-off':
        args.action = 'proxy-off';
        break;
      case '--status':
        args.action = 'status';
        break;
      case '--quiet':
        args.quiet = true;
        break;
      case '--help':
      case '-h':
        args.action = 'help';
        break;
      default:
        console.error(`unknown option: ${a}`);
        process.exit(2);
    }
  }
  return args;
}

async function installCaCli(dataDir) {
  const ca = loadOrCreateCA(dataDir);
  console.log(`Installing CA into the ${process.platform} trust store…`);
  console.log(`  cert: ${ca.paths.cert}`);
  const r = await installCa(dataDir);
  if (!r.ok) {
    logger.error(`Failed: ${r.error}`);
    if (r.hint) logger.error(r.hint);
    process.exitCode = 1;
  } else {
    console.log(r.message);
  }
}

async function uninstallCaCli(dataDir) {
  const ca = loadOrCreateCA(dataDir);
  console.log(`Removing CA ("${CA_CN}") from the ${process.platform} trust store…`);
  const r = await uninstallCa(dataDir);
  if (!r.ok) {
    logger.error(`Failed: ${r.error}`);
    if (r.hint) logger.error(r.hint);
    process.exitCode = 1;
  } else {
    console.log(r.message);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  quiet = args.quiet;

  if (args.action === 'help') {
    console.log(`itqan Shield proxy — local MITM proxy for AI traffic.
Usage: node src/proxy/index.js [options]

  --port N          listen port (default ${DEFAULT_PORT})
  --data-dir DIR    data directory (default ${DEFAULT_DATA_DIR})
  --upstream-ca CA  PEM CA used to verify upstream (egress) TLS
  --install-ca      install the local CA into the OS trust store, then exit
  --uninstall-ca    remove the local CA from the OS trust store, then exit
  --proxy-on        enable the OS system proxy, then exit
  --proxy-off       disable the OS system proxy (restores prior state), then exit
  --status          print status, then exit
  --quiet           only warnings and errors`);
    return;
  }

  fs.mkdirSync(args.dataDir, { recursive: true });

  if (args.action === 'install-ca') return installCaCli(args.dataDir);
  if (args.action === 'uninstall-ca') return uninstallCaCli(args.dataDir);

  if (args.action === 'proxy-on') {
    const r = await enableSystemProxy(args.port, { dataDir: args.dataDir });
    if (!r.ok) {
      logger.error(`Could not enable system proxy: ${r.error}`);
      process.exitCode = 1;
    } else {
      console.log(`System proxy enabled → 127.0.0.1:${args.port} ✓`);
    }
    return;
  }

  if (args.action === 'proxy-off') {
    const r = await disableSystemProxy({ dataDir: args.dataDir });
    if (!r.ok) {
      logger.error(`Could not disable system proxy: ${r.error}`);
      process.exitCode = 1;
    } else {
      console.log('System proxy disabled (prior state restored) ✓');
    }
    return;
  }

  if (args.action === 'status') {
    const ca = loadOrCreateCA(args.dataDir);
    console.log('itqan Shield proxy status');
    console.log(`  data dir : ${args.dataDir}`);
    console.log(`  CA cert  : ${ca.paths.cert}`);
    const st = await getSystemProxyState();
    console.log(`  OS proxy : ${st.ok ? (st.enabled ? `enabled (${st.server || 'see services'})` : 'disabled') : st.error}`);
    return;
  }

  // --- run
  console.log('');
  console.log('  ┌─────────────────────────────────────────┐');
  console.log('  │           itqan Shield proxy           │');
  console.log('  │         local AI traffic filter         │');
  console.log('  └─────────────────────────────────────────┘');
  console.log('');

  const upstream = {};
  if (args.upstreamCa) {
    upstream.ca = fs.readFileSync(args.upstreamCa);
    console.log(`Upstream egress CA : ${args.upstreamCa}`);
  }

  const { port, stop } = await startProxy({
    port: args.port,
    dataDir: args.dataDir,
    logger,
    upstream,
  });

  console.log(`Listening on 127.0.0.1:${port}`);
  console.log(`CA cert : ${loadOrCreateCA(args.dataDir).paths.cert}`);
  console.log('Point your agent at this proxy, e.g.:');
  console.log(`  curl -x http://127.0.0.1:${port} --cacert <ca.pem> https://example.com`);
  console.log('');

  const shutdown = async () => {
    await stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error(err.stack || err.message);
  process.exit(1);
});
