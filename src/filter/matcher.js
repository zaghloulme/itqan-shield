'use strict';

/**
 * Keyword matching engine — the local, deterministic filter core.
 *
 * Design follows privacy-filter.cpp's scanner contract: matches are emitted as
 * *spans* with character offsets into the scanned text, a label/category, and a
 * score, so any scanner (keyword engine today, an NER model sidecar later — see
 * src/filter/engine.js) produces the same shape the ask-dialog and the log
 * consume.
 *
 * Two matchers:
 *  - Aho-Corasick automaton for literal keywords (case-insensitive) — O(n)
 *    regardless of how many keywords are loaded.
 *  - Per-entry RegExp for `regex` match mode (word-boundary, patterns).
 */

/** Build an Aho-Corasick automaton over literal keywords. */
function buildAhoCorasick(keywords) {
  // keywords: [{ text, label }]  (text is lowercased by the caller)
  const root = { next: new Map(), fail: null, output: [] };

  // Insert all patterns.
  for (const kw of keywords) {
    let node = root;
    for (const ch of kw.text) {
      if (!node.next.has(ch)) node.next.set(ch, { next: new Map(), fail: null, output: [] });
      node = node.next.get(ch);
    }
    node.output.push(kw);
  }

  // BFS failure links.
  const queue = [];
  for (const child of root.next.values()) {
    child.fail = root;
    queue.push(child);
  }
  while (queue.length) {
    const node = queue.shift();
    for (const [ch, child] of node.next) {
      let fail = node.fail;
      while (fail && !fail.next.has(ch)) fail = fail.fail;
      child.fail = fail ? fail.next.get(ch) : root;
      child.output = child.output.concat(child.fail.output);
      queue.push(child);
    }
  }

  return root;
}

/** Unicode-aware word char test for 'word' boundary mode. */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * Scan `text` with the automaton. Returns spans sorted by start.
 * Each span: { label, category, start, end, score, context }.
 * `context` is ±contextSize chars around the match, with the match itself
 * marked using \x00..\x01 sentinels (callers replace with <mark>).
 */
function scanAho(text, root, { contextSize = 60 } = {}) {
  const lower = text.toLowerCase();
  const spans = [];
  let node = root;
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    while (node && node !== root && !node.next.has(ch)) node = node.fail;
    node = node && node.next.has(ch) ? node.next.get(ch) : root;
    if (node.output.length) {
      for (const kw of node.output) {
        const start = i - kw.text.length + 1;
        if (start < 0) continue; // prefix of a longer keyword already handled
        if (kw.mode === 'word') {
          const before = start > 0 ? lower[start - 1] : ' ';
          const after = i + 1 < lower.length ? lower[i + 1] : ' ';
          if (WORD_CHAR.test(before) || WORD_CHAR.test(after)) continue;
        }
        spans.push(makeSpan(text, kw, start, i + 1, contextSize));
      }
    }
  }
  return spans.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Scan with per-entry regexes (word-boundary / pattern mode).
 * Each regex must have the 'g' flag; `text` is scanned in original case.
 */
function scanRegexes(text, entries, { contextSize = 60 } = {}) {
  const spans = [];
  for (const entry of entries) {
    entry.re.lastIndex = 0;
    let m;
    while ((m = entry.re.exec(text)) !== null) {
      if (m[0].length === 0) {
        entry.re.lastIndex += 1; // guard against zero-width matches
        continue;
      }
      spans.push(makeSpan(text, { text: entry.text, label: entry.label, category: entry.category }, m.index, m.index + m[0].length, contextSize));
      if (entry.re.lastIndex === m.index) entry.re.lastIndex += 1;
    }
  }
  return spans.sort((a, b) => a.start - b.start || a.end - b.end);
}

function makeSpan(text, kw, start, end, contextSize) {
  const ctxStart = Math.max(0, start - contextSize);
  const ctxEnd = Math.min(text.length, end + contextSize);
  // Mark the match with sentinels so the UI can highlight it.
  let context = text.slice(ctxStart, start) + '\x00' + text.slice(start, end) + '\x01' + text.slice(end, ctxEnd);
  return {
    label: kw.label,
    category: kw.category || 'keyword',
    start,
    end,
    score: 1.0,
    context,
    keyword: kw.text,
  };
}

/**
 * Top-level matcher. `rules` = [{ text, label, category, mode }]
 * where mode ∈ 'literal' | 'word' | 'regex'.
 * Returns deduplicated, sorted spans.
 */
function matchKeywords(text, rules, opts = {}) {
  const literals = [];
  const regexes = [];
  for (const r of rules) {
    if (!r.enabled) continue;
    if (r.mode === 'regex') {
      let re;
      try {
        re = new RegExp(r.pattern, 'gi');
      } catch {
        continue; // malformed rule: skip, never crash the proxy
      }
      regexes.push({ ...r, label: r.pattern || r.text, re });
    } else {
      literals.push({ ...r, text: r.text.toLowerCase(), label: r.text });
    }
  }
  const root = buildAhoCorasick(literals);
  const a = scanAho(text, root, opts);
  const b = scanRegexes(text, regexes, opts);
  return dedupe([...a, ...b]);
}

/** Merge overlapping/duplicate spans (same label + range). */
function dedupe(spans) {
  const seen = new Set();
  const out = [];
  for (const s of spans) {
    const key = `${s.label}\u0000${s.start}\u0000${s.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/** Replace the \x00..\x01 sentinels with highlight markup. */
function highlightContext(span) {
  return span.context
    .replace(/\x00/g, '<mark>')
    .replace(/\x01/g, '</mark>');
}

module.exports = { matchKeywords, buildAhoCorasick, scanAho, scanRegexes, highlightContext };
