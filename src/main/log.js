'use strict';

/**
 * Decision log — JSONL audit trail of filter decisions (governance "Prove").
 * Appends are cheap; the renderer reads the last N entries.
 */

const fs = require('fs');
const path = require('path');

function logPath(dataDir) {
  return path.join(dataDir, 'shield.log');
}

function append(dataDir, entry) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(logPath(dataDir), JSON.stringify(entry) + '\n');
  } catch {
    /* logging must never break the proxy */
  }
}

function recent(dataDir, limit = 200) {
  try {
    const lines = fs.readFileSync(logPath(dataDir), 'utf8').trim().split('\n');
    const entries = [];
    for (const line of lines.slice(-limit)) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        /* skip corrupt lines */
      }
    }
    return entries;
  } catch {
    return [];
  }
}

module.exports = { append, recent };
