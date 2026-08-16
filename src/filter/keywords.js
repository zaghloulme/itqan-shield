'use strict';

/**
 * Keyword store — the blocked-word list with the central/local split.
 *
 * - `central`: defaults pushed from the itqan enforce cloud (empty for now;
 *   the SyncProvider seam in src/main/sync.js will fill it).
 * - `local`: per-device overrides — user-added keywords (and future local
 *   disables of central entries).
 *
 * Persisted as keywords.json in the data dir. Loaded once at startup; the
 * in-memory copy is the source of truth for the matcher.
 *
 * Rule shape:
 *   { id, text?, pattern?, mode: 'literal'|'word'|'regex',
 *     category, action: 'ask'|'block', enabled, source: 'central'|'local' }
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function ruleId() {
  return crypto.randomBytes(6).toString('hex');
}

function emptyStore() {
  return { central: [], local: [] };
}

function load(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'keywords.json'), 'utf8'));
    return {
      central: Array.isArray(raw.central) ? raw.central : [],
      local: Array.isArray(raw.local) ? raw.local : [],
    };
  } catch {
    return emptyStore();
  }
}

function save(dataDir, store) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'keywords.json'), JSON.stringify(store, null, 2), { mode: 0o600 });
}

/** All enabled rules, resolved (central first so local can shadow by label later). */
function enabledRules(store) {
  return [...store.central, ...store.local].filter((r) => r.enabled !== false);
}

/** Add a rule to the local list. Returns the new rule (with id). */
function addLocalRule(store, input) {
  const rule = {
    id: ruleId(),
    text: input.text,
    pattern: input.pattern,
    mode: input.mode || 'word',
    category: input.category || 'blocked',
    action: input.action || 'ask',
    enabled: input.enabled !== false,
    source: 'local',
    createdAt: new Date().toISOString(),
  };
  store.local.push(rule);
  return rule;
}

function removeLocalRule(store, id) {
  const before = store.local.length;
  store.local = store.local.filter((r) => r.id !== id);
  return store.local.length < before;
}

module.exports = { emptyStore, load, save, enabledRules, addLocalRule, removeLocalRule };
