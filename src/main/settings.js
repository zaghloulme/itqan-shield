'use strict';

/**
 * App settings persistence (settings.json in the data dir).
 * Holds: agent enabled states, custom agents, ask-dialog timeout.
 */

const fs = require('fs');
const path = require('path');

function defaults() {
  return {
    agents: {}, // { agentId: { enabled: boolean } } — absent = default-enabled
    customAgents: [], // [{ id, name, hosts }]
    askTimeoutMs: 30000,
  };
}

function load(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
    return { ...defaults(), ...raw };
  } catch {
    return defaults();
  }
}

function save(dataDir, settings) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2), { mode: 0o600 });
}

module.exports = { defaults, load, save };
