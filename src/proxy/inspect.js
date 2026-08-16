'use strict';

/**
 * Inspection seam between the proxy and the filter engine.
 *
 * M1: every request passes through untouched (log-only).
 * M2: keyword matching + agent registry plug in here.
 * M3: the "ask each time" dialog hooks in — inspectRequest becomes async and
 *     waits for the user's Allow/Deny decision before returning.
 *
 * The seam contract:
 *   inspectRequest(ctx) -> Promise<{ action: 'pass' } | {
 *     action: 'block', status: number, body: string|Buffer,
 *     headers?: Record<string,string>, reason?: string
 *   }>
 *
 * ctx = { host, port, method, target, headers, rawHeaders, body, protocol }
 *   - body: Buffer (decoded; chunked requests are re-encoded with Content-Length)
 *   - headers: lowercased-name -> value map of the client request
 */

function createInspector({ logger, failOpen = true } = {}) {
  const log = logger || console;

  return {
    failOpen,

    async inspectRequest(ctx) {
      // M1: log-only pass-through. The keyword filter lands in M2.
      log.debug(
        `[proxy] pass ${ctx.method} ${ctx.host}${ctx.target} (${ctx.body.length} bytes)`
      );
      return { action: 'pass' };
    },

    /** Called by the proxy for every decision, pass or block (M2+ uses it for the local log). */
    recordDecision(decision) {
      if (decision.action === 'block') {
        log.warn(
          `[proxy] BLOCK ${decision.method} ${decision.host}${decision.target} reason=${decision.reason || 'policy'}`
        );
      }
    },
  };
}

module.exports = { createInspector };
