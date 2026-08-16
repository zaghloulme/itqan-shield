'use strict';

/**
 * Agent registry — the "choose which agent to block on" selector.
 *
 * Known agents are matched by destination host. Custom endpoints let users add
 * their own agents (any base URL/host). Enabled state is persisted in settings.
 *
 * A host resolves to at most one agent (first match wins, exact before suffix).
 */

const KNOWN_AGENTS = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    hosts: ['chatgpt.com', 'chat.openai.com', 'chat.oaistatic.com'],
  },
  {
    id: 'claude',
    name: 'Claude',
    hosts: ['claude.ai', 'api.anthropic.com', 'anthropic.com'],
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    hosts: ['copilot.microsoft.com', 'api.githubcopilot.com', 'githubcopilot.com'],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    hosts: ['cursor.com', 'api2.cursor.sh', 'api3.cursor.sh', 'api4.cursor.sh'],
  },
  {
    id: 'gemini',
    name: 'Gemini',
    hosts: ['gemini.google.com', 'generativelanguage.googleapis.com', 'ai.google.dev'],
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    hosts: ['perplexity.ai', 'api.perplexity.ai'],
  },
  {
    id: 'openai-api',
    name: 'OpenAI API',
    hosts: ['api.openai.com'],
  },
];

/** Default enabled state: everything on except generic API endpoints. */
function defaultEnabled(id) {
  return !['openai-api'].includes(id);
}

function hostKey(host) {
  return host.toLowerCase().replace(/^www\./, '');
}

/**
 * Resolve an agent for a destination host.
 * @param {string} host destination host (e.g. 'api.openai.com')
 * @param {object[]} customAgents [{ id, name, hosts: [] }]
 * @returns {{ id, name, hosts, custom }|null}
 */
function matchAgent(host, customAgents = []) {
  const h = hostKey(host);

  // Exact match first.
  for (const a of [...KNOWN_AGENTS, ...customAgents]) {
    if (a.hosts.some((x) => hostKey(x) === h)) return { ...a };
  }
  // Suffix match (e.g. subdomain.example.com under example.com).
  for (const a of [...KNOWN_AGENTS, ...customAgents]) {
    for (const x of a.hosts) {
      const xk = hostKey(x);
      if (h.endsWith('.' + xk) || h === xk) return { ...a };
    }
  }
  return null;
}

/** Create a custom agent definition from a base URL or host. */
function customAgentFromInput(id, name, input) {
  let host = input.trim().toLowerCase();
  try {
    host = new URL(/^https?:\/\//.test(host) ? host : `https://${host}`).hostname;
  } catch {
    host = host.replace(/[^a-z0-9.\-]/g, '');
  }
  return { id, name: name || host, hosts: [host] };
}

module.exports = { KNOWN_AGENTS, matchAgent, customAgentFromInput, defaultEnabled };
