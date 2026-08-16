'use strict';

/**
 * Filter engine — the orchestrator that turns a proxied request into a
 * governance decision, plugging into the inspector seam (src/proxy/inspect.js).
 *
 * Pipeline (mirrors the scanner design of privacy-filter.cpp):
 *
 *   ctx (host, method, body, headers)
 *     → agent registry        (is this host a known/enabled agent?)
 *     → prompt extraction     (JSON messages / text → plaintext fragments)
 *     → scanners              (keyword matcher today; NER model sidecar later —
 *                              any scanner returns spans {label,start,end,score})
 *     → decision              (pass | ask | block)
 *
 * `ask` decisions are resolved by the decision provider the app injects
 * (the ask-each-time dialog). The provider returns { allow, session }.
 */

const { matchAgent } = require('./agent-registry');
const { extractPrompt } = require('./prompt-extract');
const { matchKeywords } = require('./matcher');
const { enabledRules } = require('./keywords');

const MAX_SCAN_CHARS = 1_000_000; // window cap like pf_set_window

/**
 * @param {object} opts
 * @param {object} opts.store       keyword store { central, local }
 * @param {object} opts.settings    app settings { agents: {id: {enabled}}, customAgents: [] }
 * @param {function} opts.askForDecision  async ({agent, spans, prompt}) =>
 *                                        { allow: boolean, session: boolean }
 * @param {function} [opts.onDecision]    ({decision, agent, spans, host}) → log hook
 * @param {number} [opts.askTimeoutMs]    default 30s; deny on timeout
 * @param {boolean} [opts.logger]
 */
function createEngine({ store, settings, askForDecision, onDecision, askTimeoutMs = 30000, logger = console }) {
  const sessionAllow = new Set(); // `${agentId}\u0000${label}` → auto-allow
  let pendingTimer = null; // cleared when a provider wins the race

  function agentEnabled(agent) {
    if (!agent) return false;
    const cfg = settings.agents[agent.id];
    if (cfg === undefined) return true; // default: enabled
    return !!cfg.enabled;
  }

  function findSpans(text) {
    if (!text || !text.length) return [];
    const rules = enabledRules(store);
    return matchKeywords(text.slice(0, MAX_SCAN_CHARS), rules);
  }

  async function inspectRequest(ctx) {
    const agent = matchAgent(ctx.host, settings.customAgents || []);
    if (!agent || !agentEnabled(agent)) {
      return { action: 'pass' };
    }

    const { full } = extractPrompt(ctx.body);
    if (!full || !full.trim()) return { action: 'pass' };

    const spans = findSpans(full);
    if (!spans.length) return { action: 'pass' };

    // Session auto-allow wins for previously allowed (agent, keyword) pairs.
    const actionable = spans.filter((s) => !sessionAllow.has(`${agent.id}\u0000${s.label}`));
    if (!actionable.length) return { action: 'pass' };

    const span = actionable[0]; // one dialog per request; show the first hit
    const rule = rulesForLabel(span.label);

    if (rule && rule.action === 'block') {
      report({ decision: 'block', agent, spans, host: ctx.host, rule });
      return { action: 'block', status: 403, body: `Blocked by itqan Shield policy (${span.category}: ${span.label})`, reason: span.label };
    }

    // action === 'ask' (default)
    let verdict;
    try {
      // The engine enforces the timeout itself (fail-closed): a provider that
      // hangs or never answers must not stall the proxy or let the request
      // through by default. The timer is cleared when the provider wins so no
      // timer accumulates in a long-running app.
      verdict = await Promise.race([
        askForDecision({
          agent,
          span,
          spans: actionable.slice(0, 3),
          prompt: full,
          timeoutMs: askTimeoutMs,
        }),
        new Promise((resolve) => {
          const t = setTimeout(() => resolve({ allow: false, session: false, timedOut: true }), askTimeoutMs);
          if (t.unref) t.unref(); // never hold the event loop open
          pendingTimer = t;
        }),
      ]);
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = null;
    } catch (err) {
      logger.warn(`[filter] ask failed (${err.message}) — denying by default`);
      verdict = { allow: false };
    }

    if (verdict.session) {
      for (const s of actionable) sessionAllow.add(`${agent.id}\u0000${s.label}`);
    }

    if (verdict.allow) {
      report({ decision: 'allow', agent, spans, host: ctx.host, rule });
      return { action: 'pass' };
    }
    report({ decision: 'deny', agent, spans, host: ctx.host, rule });
    return {
      action: 'block',
      status: 403,
      body: `Blocked by itqan Shield (${span.category}: ${span.label})`,
      reason: span.label,
    };
  }

  function rulesForLabel(label) {
    return enabledRules(store).find((r) => (r.text || r.pattern) === label);
  }

  function report(entry) {
    try {
      if (onDecision) onDecision({ ...entry, ts: new Date().toISOString() });
    } catch {
      /* logging must never break the proxy */
    }
  }

  return { inspectRequest, sessionAllow };
}

module.exports = { createEngine };
