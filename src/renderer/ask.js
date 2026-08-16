'use strict';

/* itqan Shield — ask dialog logic: render the hit, return the verdict. */

let currentId = null;

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function highlight(span) {
  // Escape first (prompt text is untrusted — a prompt may contain HTML), then
  // apply the matcher's \x00..\x01 sentinels as <mark>.
  return escapeHtml(span.context).replace(/\x00/g, '<mark>').replace(/\x01/g, '</mark>');
}

window.shield.onAskPrompt((p) => {
  currentId = p.id;
  document.getElementById('agent-line').textContent = `Agent: ${p.agent.name}`;
  document.getElementById('category-tag').textContent = p.span.category;
  document.getElementById('keyword-text').textContent = p.span.label;
  document.getElementById('context').innerHTML = highlight(p.span);
  const note = document.getElementById('match-note');
  note.textContent = p.spans.length > 1 ? ` +${p.spans.length - 1} more hit${p.spans.length > 2 ? 's' : ''}` : '';
});

function decide(verdict) {
  if (!currentId) return;
  window.shield.askDecision(currentId, verdict);
  currentId = null;
}

document.getElementById('deny').addEventListener('click', () => decide({ allow: false, session: false }));
document.getElementById('session').addEventListener('click', () => decide({ allow: true, session: true }));
document.getElementById('allow').addEventListener('click', () => decide({ allow: true, session: false }));
