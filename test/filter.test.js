'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matchKeywords, buildAhoCorasick, highlightContext } = require('../src/filter/matcher');
const { extractPrompt } = require('../src/filter/prompt-extract');
const { matchAgent, customAgentFromInput, KNOWN_AGENTS } = require('../src/filter/agent-registry');
const { emptyStore, addLocalRule, removeLocalRule, enabledRules } = require('../src/filter/keywords');

// ------------------------------------------------------------------ matcher

test('matcher: literal substring match', () => {
  const spans = matchKeywords('send the confidential report now', [
    { text: 'confidential', mode: 'literal', category: 'blocked', enabled: true },
  ]);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].label, 'confidential');
  assert.equal(spans[0].category, 'blocked');
  assert.equal(spans[0].start, 9);
  assert.equal(spans[0].end, 21);
});

test('matcher: case-insensitive literal', () => {
  const spans = matchKeywords('CONFIDENTIAL and Confidential and confidential', [
    { text: 'confidential', mode: 'literal', category: 'blocked', enabled: true },
  ]);
  assert.equal(spans.length, 3);
});

test('matcher: word mode respects boundaries', () => {
  const rules = [{ text: 'cat', mode: 'word', category: 'blocked', enabled: true }];
  assert.equal(matchKeywords('the cat sat', rules).length, 1);
  assert.equal(matchKeywords('concatenate cats', rules).length, 0, 'cat inside cats is not a word');
  assert.equal(matchKeywords('concatenate', rules).length, 0, 'substring inside a word must not match');
});

test('matcher: word mode is Unicode-aware', () => {
  const rules = [{ text: 'سري', mode: 'word', category: 'blocked', enabled: true }];
  assert.equal(matchKeywords('وثيقة سري للغاية', rules).length, 1, 'matches Arabic word');
  assert.equal(matchKeywords('سري للغاية سرية', rules).length, 1, 'سري does not match inside سرية');
});

test('matcher: regex mode', () => {
  const spans = matchKeywords('call me on +20 100 123 4567 or 02 1234 5678', [
    { text: 'phone', pattern: '\\+?\\d[\\d\\s-]{8,}', mode: 'regex', category: 'pii', enabled: true },
  ]);
  assert.ok(spans.length >= 1);
  assert.equal(spans[0].category, 'pii');
});

test('matcher: malformed regex is skipped, never throws', () => {
  const spans = matchKeywords('hello world', [
    { text: 'bad', pattern: '([unclosed', mode: 'regex', category: 'x', enabled: true },
    { text: 'hello', mode: 'literal', category: 'x', enabled: true },
  ]);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].label, 'hello');
});

test('matcher: multiple keywords via Aho-Corasick', () => {
  const rules = ['alpha', 'beta', 'gamma', 'delta'].map((t) => ({ text: t, mode: 'literal', category: 'blocked', enabled: true }));
  const spans = matchKeywords('alpha beta delta epsilon', rules);
  assert.equal(spans.length, 3);
});

test('matcher: overlapping keywords dedupe and sort by offset', () => {
  const rules = [
    { text: 'data', mode: 'literal', category: 'a', enabled: true },
    { text: 'database', mode: 'literal', category: 'b', enabled: true },
  ];
  const spans = matchKeywords('the database is big', rules);
  assert.equal(spans.length, 2);
  assert.deepEqual(spans.map((s) => s.start), [4, 4]);
  assert.deepEqual(spans.map((s) => s.end), [8, 12]);
});

test('matcher: context marks the match with sentinels', () => {
  const spans = matchKeywords('x'.repeat(100) + ' SECRET ' + 'y'.repeat(100), [
    { text: 'secret', mode: 'word', category: 'blocked', enabled: true },
  ]);
  assert.equal(spans.length, 1);
  const html = highlightContext(spans[0]);
  assert.match(html, /<mark>SECRET<\/mark>/);
});

test('matcher: disabled rules are ignored', () => {
  const spans = matchKeywords('secret', [
    { text: 'secret', mode: 'literal', category: 'a', enabled: false },
  ]);
  assert.equal(spans.length, 0);
});

// --------------------------------------------------------- prompt extraction

test('extractPrompt: OpenAI-style messages', () => {
  const { fragments, full } = extractPrompt(
    JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'What is the capital of Egypt?' },
      ],
    })
  );
  assert.equal(fragments.length, 2);
  assert.equal(fragments[0].role, 'system');
  assert.equal(fragments[1].role, 'user');
  assert.match(full, /capital of Egypt/);
});

test('extractPrompt: Anthropic-style content blocks', () => {
  const { fragments } = extractPrompt(
    JSON.stringify({
      model: 'claude-3-5-sonnet',
      max_tokens: 1024,
      system: [{ type: 'text', text: 'You are Claude.' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Redact my SSN 123-45-6789' }] }],
    })
  );
  const all = fragments.map((f) => f.text).join(' ');
  assert.match(all, /You are Claude/);
  assert.match(all, /123-45-6789/);
});

test('extractPrompt: bare text body', () => {
  const { fragments, full } = extractPrompt('just some plain text with secrets');
  assert.equal(fragments.length, 1);
  assert.match(full, /plain text/);
});

test('extractPrompt: { prompt } / { input } shorthand', () => {
  const a = extractPrompt(JSON.stringify({ prompt: 'summarize this' }));
  assert.equal(a.fragments.length, 1);
  const b = extractPrompt(JSON.stringify({ input: 'classify that' }));
  assert.equal(b.fragments.length, 1);
});

test('extractPrompt: empty body returns no fragments', () => {
  assert.equal(extractPrompt('').fragments.length, 0);
  assert.equal(extractPrompt(Buffer.from('   ')).fragments.length, 0);
});

// ------------------------------------------------------------- agent match

test('agents: known host resolves', () => {
  const a = matchAgent('chatgpt.com');
  assert.equal(a.id, 'chatgpt');
  const b = matchAgent('api.anthropic.com');
  assert.equal(b.id, 'claude');
});

test('agents: www prefix normalized', () => {
  assert.equal(matchAgent('www.claude.ai').id, 'claude');
});

test('agents: subdomain suffix match', () => {
  const a = matchAgent('eu.api.anthropic.com');
  assert.equal(a.id, 'claude');
});

test('agents: unknown host returns null', () => {
  assert.equal(matchAgent('example.com'), null);
});

test('agents: custom agent input normalizes to host', () => {
  const a = customAgentFromInput('c1', 'My Agent', 'https://my-agent.example.com/path');
  assert.equal(a.hosts[0], 'my-agent.example.com');
  const b = matchAgent('my-agent.example.com', [a]);
  assert.equal(b.id, 'c1');
  assert.equal(b.name, 'My Agent');
});

test('agents: case-insensitive custom host', () => {
  const a = customAgentFromInput('c2', '', 'MyAgent.EXAMPLE.com');
  assert.equal(matchAgent('myagent.example.com', [a]).id, 'c2');
});

// ------------------------------------------------------------- keyword store

test('keywords: add/remove local rules, enabled rules merge central+local', () => {
  const store = emptyStore();
  store.central.push({ id: 'c1', text: 'cloudword', mode: 'word', action: 'ask', category: 'x', enabled: true, source: 'central' });
  const rule = addLocalRule(store, { text: 'localword', mode: 'word', action: 'ask', category: 'y' });
  assert.equal(rule.source, 'local');
  assert.ok(rule.id);
  assert.equal(enabledRules(store).length, 2);
  assert.ok(removeLocalRule(store, rule.id));
  assert.equal(enabledRules(store).length, 1);
  assert.equal(removeLocalRule(store, 'nope'), false);
});
