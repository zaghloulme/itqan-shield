'use strict';

/**
 * Cloud sync seam (M4+) — the desktop-first placeholder.
 *
 * Later milestones will sync the central keyword list, skills, and MCP
 * connectors with the itqan enforce cloud. Everything the app needs from the
 * cloud flows through here, so the desktop app keeps working with a local-only
 * store until then.
 *
 * Contract:
 *   syncKeywords() → Promise<{ central: Rule[] }>  (applied to keyword store)
 *   syncMCP()      → Promise<MCPConnector[]>        (M2+; not yet consumed)
 *   reportEvents() → Promise<void>                  (push decision log to cloud)
 */

async function syncKeywords() {
  // Desktop-first: no cloud yet. Return an empty central list; the store's
  // local list is the source of truth until the enforce APIs exist.
  return { central: [] };
}

async function syncMCP() {
  return [];
}

async function reportEvents() {
  return;
}

module.exports = { syncKeywords, syncMCP, reportEvents };
