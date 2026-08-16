'use strict';

/**
 * Prompt extraction — pull the plaintext the model would see out of request
 * bodies, so the filter can inspect it.
 *
 * Handles the common shapes:
 *  - OpenAI-compatible:  { messages: [{ role, content }] }  (content string)
 *  - Anthropic:          { messages: [{ role, content: [blocks] }] },
 *                        system: string | [blocks]
 *  - Bare text:          text/plain body, or { prompt } / { input } / { query }
 *  - Tool calls:         { tool_calls: [{ function: { name, arguments } }] }
 *
 * Returns [{ role, text }] fragments plus the concatenated `full` text, with
 * character offsets into `full` for each fragment (spans can then map back).
 */

const FRAGMENT_KEYS = new Set(['content', 'prompt', 'input', 'query']);

function collectStrings(node, role, out) {
  if (node == null) return;
  if (typeof node === 'string') {
    if (node.length) out.push({ role, text: node });
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectStrings(item, role, out);
    return;
  }
  if (typeof node === 'object') {
    // Anthropic content blocks: { type: 'text', text: '...' }
    if (typeof node.text === 'string' && node.text.length) {
      out.push({ role, text: node.text });
    }
    for (const [key, value] of Object.entries(node)) {
      if (FRAGMENT_KEYS.has(key)) collectStrings(value, role, out);
      else if (key === 'tool_calls' || key === 'function') collectStrings(value, role, out);
    }
  }
}

/**
 * Extract prompt fragments from a request body buffer.
 * @returns {{ fragments: [{role, text}], full: string }|null}
 *   null when nothing extractable (caller treats as no-op).
 */
function extractPrompt(body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  if (!text.trim()) return { fragments: [], full: '' };

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }

  const fragments = [];
  if (json && typeof json === 'object') {
    if (Array.isArray(json.messages)) {
      for (const msg of json.messages) {
        collectStrings(msg.content, (msg.role || 'user').toLowerCase(), fragments);
      }
    }
    if (json.system !== undefined) collectStrings(json.system, 'system', fragments);
    for (const key of ['prompt', 'input', 'query']) {
      if (json[key] !== undefined) collectStrings(json[key], 'user', fragments);
    }
  } else {
    fragments.push({ role: 'body', text });
  }

  const withText = fragments.filter((f) => f.text.trim().length > 0);
  if (!withText.length) return { fragments: [], full: '' };

  // Concatenate with offsets.
  let full = '';
  for (const f of withText) {
    f.offset = full.length;
    full += f.text + '\n';
  }
  return { fragments: withText, full };
}

module.exports = { extractPrompt };
