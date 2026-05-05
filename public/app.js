const FIELDS = [
  'title', 'authors', 'affiliations', 'abstract', 'keywords',
  'introduction', 'methods', 'results', 'discussion', 'conclusions',
  'references', 'bibtex',
];
const CHECKABLE = ['abstract', 'introduction', 'methods', 'results', 'discussion', 'conclusions'];

const $ = (id) => document.getElementById(id);
const els = Object.fromEntries(FIELDS.map((f) => [f, $(f)]));

const state = {
  id: null,
  issuesByField: {},
};

const STORAGE_KEY = 'mdpi-builder-draft-v1';

function snapshot() {
  const data = { id: state.id };
  FIELDS.forEach((f) => (data[f] = els[f].value));
  return data;
}
function restoreFrom(data) {
  if (!data) return;
  state.id = data.id || null;
  FIELDS.forEach((f) => {
    if (els[f] && typeof data[f] === 'string') els[f].value = data[f];
  });
  renderPreview();
}
function autosave() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot())); } catch {}
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderTextWithIssues(field, raw) {
  const issues = state.issuesByField[field];
  const text = raw || '';
  if (!issues || !issues.length) {
    return splitParagraphs(text).map((p) => `<p>${escapeHtml(p)}</p>`).join('');
  }
  const sorted = [...issues].sort((a, b) => a.offset - b.offset);
  let out = '';
  let cursor = 0;
  for (const it of sorted) {
    if (it.offset < cursor) continue;
    out += escapeHtml(text.slice(cursor, it.offset));
    const seg = text.slice(it.offset, it.offset + it.length);
    const cls = it.issueType === 'misspelling' ? 'lt-issue lt-spelling' : 'lt-issue';
    const tip = (it.message || '').replace(/"/g, '&quot;');
    out += `<span class="${cls}" title="${tip}">${escapeHtml(seg)}</span>`;
    cursor = it.offset + it.length;
  }
  out += escapeHtml(text.slice(cursor));
  return out
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function splitParagraphs(text) {
  return (text || '').split(/\n{2,}/).filter((p) => p.trim().length);
}

function renderPreview(target) {
  const root = target || $('preview');
  const title = els.title.value || 'Untitled';
  const authors = els.authors.value || '';
  const affiliations = els.affiliations.value || '';
  const abstractText = els.abstract.value || '';
  const keywords = els.keywords.value || '';

  const sections = [
    ['1. Introduction', 'introduction'],
    ['2. Materials and Methods', 'methods'],
    ['3. Results', 'results'],
    ['4. Discussion', 'discussion'],
    ['5. Conclusions', 'conclusions'],
  ];

  const sectionsHtml = sections
    .filter(([, f]) => els[f].value.trim().length)
    .map(([h, f]) => `<h2>${escapeHtml(h)}</h2>${renderTextWithIssues(f, els[f].value)}`)
    .join('');

  const refs = (els.references.value || '')
    .split(/\n+/)
    .map((r) => r.trim())
    .filter(Boolean);
  const refsHtml = refs.length
    ? `<div class="references"><h2>References</h2><ol>${refs.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ol></div>`
    : '';

  root.innerHTML = `
    <h1 class="doc-title">${escapeHtml(title)}</h1>
    ${authors ? `<div class="authors">${escapeHtml(authors)}</div>` : ''}
    ${affiliations ? `<div class="affiliations">${escapeHtml(affiliations)}</div>` : ''}
    ${abstractText ? `<div class="abstract-block"><span class="label">Abstract:</span>${renderTextWithIssues('abstract', abstractText)}</div>` : ''}
    ${keywords ? `<div class="keywords"><span class="label">Keywords:</span> ${escapeHtml(keywords)}</div>` : ''}
    <div class="body">${sectionsHtml}</div>
    ${refsHtml}
  `;
  if (!target) updateDraftMeter();
}

function updateDraftMeter() {
  const meter = $('draft-meter');
  if (!meter) return;
  const sections = ['introduction', 'methods', 'results', 'discussion', 'conclusions'];
  const filledSections = sections.filter((f) => els[f].value.trim().length).length;
  const wordCount = FIELDS
    .filter((f) => f !== 'bibtex')
    .reduce((sum, f) => sum + countWords(els[f].value), 0);
  meter.textContent = `${filledSections}/5 sections, ${wordCount} words`;
}

function countWords(text) {
  return (text || '').trim().split(/\s+/).filter(Boolean).length;
}

async function runCheck() {
  setStatus('Checking...');
  $('btn-check').disabled = true;
  state.issuesByField = {};

  let total = 0;
  try {
    for (const f of CHECKABLE) {
      const text = els[f].value;
      if (!text || !text.trim()) continue;
      const r = await fetch('/api/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, language: 'en-US' }),
      });
      if (!r.ok) {
        const detail = await r.json().catch(() => ({}));
        throw new Error(detail.detail || detail.error || `HTTP ${r.status}`);
      }
      const data = await r.json();
      const matches = (data.matches || []).map((m) => ({
        offset: m.offset,
        length: m.length,
        message: m.message,
        shortMessage: m.shortMessage,
        replacements: (m.replacements || []).slice(0, 5).map((x) => x.value),
        ruleId: m.rule && m.rule.id,
        category: m.rule && m.rule.category && m.rule.category.id,
        issueType: m.rule && m.rule.issueType,
      }));
      state.issuesByField[f] = matches;
      total += matches.length;
      els[f].toggleAttribute('data-has-issues', matches.length > 0);
    }
    setStatus(total === 0 ? 'No issues found' : `${total} issue${total === 1 ? '' : 's'} found`, total === 0 ? 'ok' : '');
    renderIssuesPanel();
    renderPreview();
    $('btn-fix-all').disabled = total === 0;
  } catch (err) {
    setStatus('Check failed: ' + err.message, 'error');
  } finally {
    $('btn-check').disabled = false;
  }
}

function renderIssuesPanel() {
  const list = $('issues-list');
  const panel = $('issues-panel');
  const all = [];
  for (const f of CHECKABLE) {
    for (const m of state.issuesByField[f] || []) all.push({ field: f, ...m });
  }
  if (!all.length) {
    list.innerHTML = '<div class="issue empty">No suggestions found.</div>';
    panel.hidden = false;
    return;
  }
  list.innerHTML = all.map((m, idx) => {
    const text = els[m.field].value;
    const ctx = renderContext(text, m.offset, m.length);
    const sugg = m.replacements
      .map((s, i) => `<button data-idx="${idx}" data-rep="${i}">${escapeHtml(s)}</button>`)
      .join('');
    const cls = m.issueType === 'misspelling' ? 'issue spelling' : 'issue';
    return `<div class="${cls}" data-idx="${idx}">
      <div class="where">${m.field} / ${m.category || m.ruleId || 'style'}</div>
      <div class="msg">${escapeHtml(m.message)}</div>
      <div class="ctx">${ctx}</div>
      ${sugg ? `<div class="suggestions">${sugg}</div>` : ''}
    </div>`;
  }).join('');
  panel.hidden = false;

  list.querySelectorAll('.suggestions button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = +btn.dataset.idx;
      const rep = +btn.dataset.rep;
      applyReplacement(all[idx], rep);
    });
  });
}

function renderContext(text, off, len) {
  const before = escapeHtml(text.slice(Math.max(0, off - 30), off));
  const seg = escapeHtml(text.slice(off, off + len));
  const after = escapeHtml(text.slice(off + len, off + len + 30));
  return `...${before}<mark>${seg}</mark>${after}...`;
}

function applyReplacement(issue, replacementIdx) {
  const replacement = issue.replacements[replacementIdx];
  if (replacement == null) return;
  const f = issue.field;
  const text = els[f].value;
  const newText = text.slice(0, issue.offset) + replacement + text.slice(issue.offset + issue.length);
  els[f].value = newText;
  const delta = replacement.length - issue.length;
  state.issuesByField[f] = (state.issuesByField[f] || [])
    .filter((m) => !(m.offset === issue.offset && m.length === issue.length))
    .map((m) => (m.offset > issue.offset ? { ...m, offset: m.offset + delta } : m));
  els[f].toggleAttribute('data-has-issues', (state.issuesByField[f] || []).length > 0);
  renderIssuesPanel();
  renderPreview();
  autosave();
}

function autoFixAll() {
  for (const f of CHECKABLE) {
    const issues = (state.issuesByField[f] || []).filter((m) => m.replacements.length);
    issues.sort((a, b) => b.offset - a.offset);
    let text = els[f].value;
    for (const m of issues) {
      text = text.slice(0, m.offset) + m.replacements[0] + text.slice(m.offset + m.length);
    }
    els[f].value = text;
    state.issuesByField[f] = [];
    els[f].removeAttribute('data-has-issues');
  }
  renderPreview();
  renderIssuesPanel();
  autosave();
  setStatus('Applied first suggestions. Re-run check to verify.', 'ok');
  $('btn-fix-all').disabled = true;
}

function setStatus(msg, kind = '') {
  const s = $('status');
  s.textContent = msg || '';
  s.className = 'status' + (kind ? ' ' + kind : '');
}

async function exportPdf() {
  const tmp = $('print-article');
  state.issuesByField = {};
  renderPreview(tmp);
  setTimeout(() => window.print(), 50);
}

async function exportDocx() {
  setStatus('Building DOCX...');
  try {
    const r = await fetch('/api/export/docx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot()),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const blob = await r.blob();
    downloadBlob(blob, (els.title.value || 'mdpi-paper').replace(/[^\w.-]+/g, '-') + '.docx');
    setStatus('DOCX downloaded', 'ok');
  } catch (err) {
    setStatus('DOCX export failed: ' + err.message, 'error');
  }
}

function exportBibtex() {
  let content = (els.bibtex.value || '').trim();
  if (!content) {
    const refs = (els.references.value || '').split(/\n+/).map((r) => r.trim()).filter(Boolean);
    if (!refs.length) {
      setStatus('No references or BibTeX to export.', 'error');
      return;
    }
    content = refs.map((r, i) => `@misc{ref${i + 1},\n  note = {${escapeBib(r)}}\n}`).join('\n\n');
  }
  const blob = new Blob([content + '\n'], { type: 'application/x-bibtex;charset=utf-8' });
  downloadBlob(blob, (els.title.value || 'mdpi-paper').replace(/[^\w.-]+/g, '-') + '.bib');
  setStatus('BibTeX downloaded', 'ok');
}

function escapeBib(s) { return s.replace(/[{}]/g, ''); }

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
}

async function save() {
  setStatus('Saving...');
  try {
    const r = await fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot()),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'save failed');
    state.id = data.id;
    autosave();
    setStatus(`Saved (id ${data.id})`, 'ok');
  } catch (err) {
    setStatus('Save failed: ' + err.message, 'error');
  }
}

async function openLoadDialog() {
  const dlg = $('load-dialog');
  const list = $('saved-list');
  list.innerHTML = '<li>Loading...</li>';
  dlg.showModal();
  try {
    const r = await fetch('/api/list');
    const items = await r.json();
    if (!items.length) { list.innerHTML = '<li>No saved papers yet.</li>'; return; }
    list.innerHTML = items.map((it) =>
      `<li data-id="${it.id}">
         <span><strong>${escapeHtml(it.title)}</strong> <span class="muted">${(it.savedAt || '').slice(0, 19).replace('T', ' ')}</span></span>
         <span>
           <button type="button" data-action="load" data-id="${it.id}">Load</button>
           <button type="button" data-action="delete" data-id="${it.id}">Delete</button>
         </span>
       </li>`
    ).join('');
    list.onclick = async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const id = btn.dataset.id;
      if (btn.dataset.action === 'load') {
        const rr = await fetch('/api/load/' + id);
        if (rr.ok) { restoreFrom(await rr.json()); dlg.close(); setStatus('Loaded', 'ok'); }
      } else if (btn.dataset.action === 'delete') {
        if (!confirm('Delete this paper?')) return;
        await fetch('/api/doc/' + id, { method: 'DELETE' });
        openLoadDialog();
      }
    };
  } catch (err) {
    list.innerHTML = `<li>Error: ${escapeHtml(err.message)}</li>`;
  }
}

function wire() {
  FIELDS.forEach((f) => {
    els[f].addEventListener('input', () => {
      if (state.issuesByField[f]) {
        state.issuesByField[f] = [];
        els[f].removeAttribute('data-has-issues');
        renderIssuesPanel();
      }
      renderPreview();
      autosave();
    });
  });

  $('btn-check').addEventListener('click', runCheck);
  $('btn-fix-all').addEventListener('click', autoFixAll);
  $('btn-save').addEventListener('click', save);
  $('btn-load').addEventListener('click', openLoadDialog);
  $('btn-export-pdf').addEventListener('click', exportPdf);
  $('btn-export-docx').addEventListener('click', exportDocx);
  $('btn-export-bib').addEventListener('click', exportBibtex);
  $('btn-close-issues').addEventListener('click', () => ($('issues-panel').hidden = true));

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) restoreFrom(JSON.parse(raw));
  } catch {}
  renderPreview();
}

document.addEventListener('DOMContentLoaded', wire);
