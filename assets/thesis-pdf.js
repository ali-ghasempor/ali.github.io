import { escapeHTML as e } from './thesis-data.js?v=2026-10-09-pdf';

const MAX_WORDS = 150000;
let libraries;
const vendor = name => new URL(`./vendor/${name}`, import.meta.url).href;
function script(name) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script'); el.src = vendor(name);
    el.onload = resolve; el.onerror = () => { el.remove(); reject(new Error('The PDF tools could not load. Refresh and try again.')); };
    document.head.append(el);
  });
}
async function libs() {
  if (!libraries) libraries = Promise.all([
    import('./vendor/pdfjs-6.4.299.mjs'), script('diff-9.0.0.js'), script('pdf-lib-1.17.1.js')
  ]).then(([pdfjs]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = vendor('pdfjs-worker-6.4.299.mjs');
    return { pdfjs, diff: window.Diff, pdfLib: window.PDFLib };
  }).catch(error => { libraries = null; throw error; });
  return libraries;
}
export function thesisBaselines(report, reports) {
  if (report.kind !== 'thesis' || !report.file_path) return [];
  return reports.filter(r => r.id !== report.id && r.student_id === report.student_id &&
    r.kind === 'thesis' && r.file_path && r.created_at < report.created_at)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}
export function validAnnotations(marks, pages = 1000) {
  if (!Array.isArray(marks) || marks.length > 200 || new TextEncoder().encode(JSON.stringify(marks)).length > 48000)
    throw new Error('Use at most 200 annotations and 48 KB of feedback.');
  const ids = new Set();
  marks.forEach((m, index) => {
    if (m?.type === 'comment' && typeof m.text === 'string' && !m.text.trim())
      throw new Error(`Comment ${index + 1} on page ${m.page} has no text. Type the comment or remove it.`);
    if (typeof m?.text === 'string' && m.text.length > 2000) throw new Error(`Comment ${index + 1} is longer than 2,000 characters.`);
    if (!m || typeof m.id !== 'string' || !m.id || m.id.length > 80 || ids.has(m.id) ||
      !['highlight','comment'].includes(m.type) || !Number.isInteger(m.page) || m.page < 1 || m.page > pages ||
      typeof m.text !== 'string' ||
      !['x','y','w','h'].every(k => Number.isFinite(m[k]) && m[k] >= 0 && m[k] <= 1) ||
      m.x + m.w > 1.001 || m.y + m.h > 1.001) throw new Error(`Annotation ${index + 1} is invalid. Remove it and add it again.`);
    ids.add(m.id);
  });
  return marks;
}
async function documentPDF(store, report, signal) {
  const url = await store.fileURL(report);
  try {
    const response = await fetch(url, { signal, cache: 'no-store', credentials: 'omit' });
    if (!response.ok) throw new Error('The PDF could not be opened. Close this view and try again.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 20971520) throw new Error('This PDF exceeds the 20 MB limit.');
    const { pdfjs } = await libs();
    const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, useWasm: false,
      standardFontDataUrl: vendor('pdfjs-fonts/'), disableFontFace: true });
    const abort = () => { void task.destroy(); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const pdf = await task.promise;
      if (signal.aborted) { await task.destroy(); throw new DOMException('Closed', 'AbortError'); }
      if (pdf.numPages > 1000) { await task.destroy(); throw new Error('PDF tools support up to 1,000 pages.'); }
      return { pdf, bytes, dispose: async () => { signal.removeEventListener('abort', abort); await task.destroy(); } };
    } catch (error) {
      signal.removeEventListener('abort', abort);
      await task.destroy();
      if (error.name === 'PasswordException') throw new Error('Upload a PDF without a password to use comparison and feedback.');
      throw error;
    }
  } finally { if (url.startsWith('blob:')) URL.revokeObjectURL(url); }
}
let measurer;
// Width of text in a similar browser font. Only the proportions within one run are used.
function measure(text, family) {
  measurer ||= document.createElement('canvas').getContext('2d');
  measurer.font = `100px ${family || 'sans-serif'}`;
  return measurer.measureText(text).width;
}
// Approximate box of part of a text run, as fractions of the page, so changed words can be marked on the
// rendered PDF. Rotated text is still compared but not marked.
function runBoxes(item, viewport, styles) {
  const [, b, c, d, x, y] = item.transform, length = item.str.length;
  if (Math.abs(b) > 1e-3 || Math.abs(c) > 1e-3 || !item.width || !length) return () => null;
  const size = Math.abs(d) || item.height || 10, family = styles?.[item.fontName]?.fontFamily, total = measure(item.str, family);
  // Share of the run's width before a character position; equal widths if the font cannot be measured.
  const offset = at => total > 0 ? measure(item.str.slice(0, at), family) / total : at / length;
  return (start, count) => {
    const left = x + item.width * offset(start), right = x + item.width * offset(start + count);
    const [x1, y1] = viewport.convertToViewportPoint(left, y - size * .22), [x2, y2] = viewport.convertToViewportPoint(right, y + size * .85);
    return { x: Math.min(x1, x2) / viewport.width, y: Math.min(y1, y2) / viewport.height,
      w: Math.abs(x2 - x1) / viewport.width, h: Math.abs(y2 - y1) / viewport.height };
  };
}
// Compare words across the whole document, rather than page-by-page: an added
// paragraph should not flag every following page when pagination shifts.
async function words(document, signal, status) {
  const lines = [], edges = new Map(); let count = 0, textPages = 0;
  for (let page = 1; page <= document.numPages; page++) {
    if (signal.aborted) throw new DOMException('Closed', 'AbortError');
    status(`Reading page ${page} of ${document.numPages}…`);
    const p = await document.getPage(page), content = await p.getTextContent(), viewport = p.getViewport({ scale: 1 });
    const height = p.view[3] - p.view[1];
    if (content.items.some(i => i.str?.trim())) textPages++;
    for (const item of content.items) {
      if (!item.str?.trim()) continue;
      const text = item.str.normalize('NFKC').replace(/­/g, '').trim();
      const edge = p.rotate % 180 === 0 && (item.transform[5] - p.view[1] < height * 0.06 || item.transform[5] - p.view[1] > height * 0.94);
      if (edge) { const key = text.replace(/\d+/g, '#'); if (!edges.has(key)) edges.set(key, new Set()); edges.get(key).add(page); }
      const box = runBoxes(item, viewport, content.styles), parts = [];
      for (const match of item.str.matchAll(/\S+/g)) {
        const where = box(match.index, match[0].length);
        for (const word of match[0].normalize('NFKC').replace(/­/g, '').split(/\s+/)) if (word) parts.push({ text: word, box: where });
      }
      if (!parts.length) continue;
      lines.push({ text, page, edge, eol: item.hasEOL, parts });
      count += parts.length;
      if (count > MAX_WORDS) throw new Error('This PDF has too much text for browser comparison. Compare a shorter draft.');
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  const tokens = [];
  for (const line of lines) {
    // Ignore repeated running headers and footers, including changing page numbers.
    if (document.numPages > 1 && line.edge && edges.get(line.text.replace(/\d+/g, '#'))?.size >= Math.max(2, Math.ceil(document.numPages * .5))) continue;
    const parts = [...line.parts];
    if (tokens.at(-1)?.join) {
      const last = tokens.at(-1), first = parts.shift();
      last.text = last.text.slice(0, -1) + first.text; if (first.box) last.boxes.push(first.box); delete last.join;
    }
    for (const part of parts) tokens.push({ text: part.text, page: line.page, boxes: part.box ? [part.box] : [] });
    if (line.eol && /[\p{L}]-$/u.test(parts.at(-1)?.text || '')) tokens.at(-1).join = true;
  }
  return { tokens, textPages };
}
// Longest chain of anchors that keeps the same order in both drafts (patience sorting).
function ordered(anchors) {
  const tails = [], previous = [];
  anchors.forEach((anchor, index) => {
    let low = 0, high = tails.length;
    while (low < high) { const mid = (low + high) >> 1; if (anchors[tails[mid]][1] < anchor[1]) low = mid + 1; else high = mid; }
    previous[index] = low ? tails[low - 1] : -1; tails[low] = index;
  });
  const chain = [];
  for (let i = tails.at(-1) ?? -1; i >= 0; i = previous[i]) chain.push(anchors[i]);
  return chain.reverse();
}
// Word diff that scales to whole theses with major rewrites: equal openings and endings are trimmed, words
// that occur once in both stretches anchor the alignment, and only the short stretches between anchors get
// the exact (slow) diff. Moved text shows as removed in one place and added in another.
export async function alignWords(a, b, exact, signal) {
  const parts = [], todo = [[0, a.length, 0, b.length]];
  const emit = (key, count) => {
    if (!count) return;
    const last = parts.at(-1);
    if (last && Boolean(last.added) === (key === 'added') && Boolean(last.removed) === (key === 'removed')) last.count += count;
    else parts.push({ count, added: key === 'added', removed: key === 'removed' });
  };
  // A stretch with no reliable alignment counts as fully rewritten; its removal is listed before the addition.
  const replace = (from, to, newFrom, newTo) => { emit('removed', to - from); emit('added', newTo - newFrom); };
  let pause = performance.now();
  while (todo.length) {
    if (performance.now() - pause > 40) {
      await new Promise(resolve => setTimeout(resolve, 0)); pause = performance.now();
      if (signal?.aborted) throw new DOMException('Closed', 'AbortError');
    }
    const task = todo.pop();
    if (task.length === 1) { emit('same', task[0]); continue; }
    let [from, to, newFrom, newTo] = task;
    while (from < to && newFrom < newTo && a[from] === b[newFrom]) { from++; newFrom++; }
    emit('same', from - task[0]);
    let end = 0;
    while (to - end > from && newTo - end > newFrom && a[to - end - 1] === b[newTo - end - 1]) end++;
    to -= end; newTo -= end;
    if (end) todo.push([end]);
    if (from === to || newFrom === newTo) { replace(from, to, newFrom, newTo); continue; }
    const size = to - from + newTo - newFrom;
    if (size <= 2000) {
      const found = exact(a.slice(from, to), b.slice(newFrom, newTo), size);
      if (found) for (const part of found) emit(part.added ? 'added' : part.removed ? 'removed' : 'same', part.count);
      else replace(from, to, newFrom, newTo);
      continue;
    }
    const seen = new Map();
    for (let i = from; i < to; i++) { const s = seen.get(a[i]); if (s) s.old++; else seen.set(a[i], { old: 1, at: i, current: 0 }); }
    for (let j = newFrom; j < newTo; j++) { const s = seen.get(b[j]); if (s) { s.current++; s.newAt = j; } }
    const anchors = [];
    for (const s of seen.values()) if (s.old === 1 && s.current === 1) anchors.push([s.at, s.newAt]);
    anchors.sort((x, y) => x[0] - y[0]);
    const chain = ordered(anchors);
    if (!chain.length) {
      const found = exact(a.slice(from, to), b.slice(newFrom, newTo), Math.min(size, 3000));
      if (found) for (const part of found) emit(part.added ? 'added' : part.removed ? 'removed' : 'same', part.count);
      else replace(from, to, newFrom, newTo);
      continue;
    }
    // Stretches between anchors, queued so they are processed in reading order.
    const pieces = []; let i = from, j = newFrom;
    for (const [x, y] of chain) { pieces.push([i, x, j, y], [1]); i = x + 1; j = y + 1; }
    pieces.push([i, to, j, newTo]);
    for (let k = pieces.length - 1; k >= 0; k--) todo.push(pieces[k]);
  }
  return parts;
}
// A change is minor when only numbers, punctuation, capitals or spacing differ: page numbers in the table of
// contents, renumbered figures and citations, comma fixes. Decimals and percentages always count as real changes.
export function minorChange(removed, added) {
  if ([...removed, ...added].some(w => /%|^\D*\d+[.,]\d+\D*$/.test(w))) return false;
  const letters = list => list.join('').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}]/gu, '');
  return letters(removed) === letters(added);
}
async function changes(before, after, signal) {
  const { diff } = await libs();
  const parts = await alignWords(before.map(w => w.text), after.map(w => w.text),
    (x, y, limit) => diff.diffArrays(x, y, { maxEditLength: limit }), signal);
  const groups = []; let old = 0, current = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part.added && !part.removed) { old += part.count; current += part.count; continue; }
    // oldAt/newAt mark where the change sits in each draft, also when one side has no words.
    const group = { before: before.slice(Math.max(0, old - 12), old).map(t => t.text).join(' '), removed: [], added: [], oldAt: old, newAt: current };
    while (i < parts.length && (parts[i].added || parts[i].removed)) {
      const next = parts[i];
      if (next.removed) { group.removed.push(...before.slice(old, old + next.count)); old += next.count; }
      else { group.added.push(...after.slice(current, current + next.count)); current += next.count; }
      i++;
    }
    group.after = after.slice(current, current + 12).map(t => t.text).join(' ');
    group.minor = minorChange(group.removed.map(t => t.text), group.added.map(t => t.text));
    groups.push(group); i--;
  }
  return { groups };
}
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const pageRange = tokens => tokens.length ? ' · page ' + tokens[0].page + (tokens.at(-1).page !== tokens[0].page ? '–' + tokens.at(-1).page : '') : '';
// Join word boxes on the same line into one band, so a changed phrase reads as one mark.
function bands(boxes) {
  const out = [];
  for (const b of boxes) {
    const last = out.at(-1);
    if (last && Math.abs(last.y - b.y) < last.h * .5 && b.x >= last.x && b.x - (last.x + last.w) < last.h * 1.5) {
      const right = Math.max(last.x + last.w, b.x + b.w); last.w = right - last.x;
    } else out.push({ ...b });
  }
  return out;
}
const uploaded = r => new Date(r.created_at).toLocaleString('en-GB', { timeZone: 'Europe/Tallinn' });
const fileBase = r => (r.file_name || 'thesis').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]+/g, '_');
function save(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], { type })), link = document.createElement('a');
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
// Ready-made request for ChatGPT: the supervisor attaches both drafts and the change list, then pastes this.
function aiPrompt([previous, latest, list], selected, report) {
  return `I supervise this student's thesis. They have submitted a new draft, and I want an overview of what changed since the previous draft before I check the details myself.

I have attached three files:
- ${previous}: the previous draft (uploaded ${uploaded(selected)})
- ${latest}: the current draft (uploaded ${uploaded(report)})
- ${list}: the text differences found by a word-by-word comparison of the two PDFs, with the page of each change in both drafts. Minor changes (page numbers, figure, table and citation numbering, punctuation, capitals) are already left out.

Please:
1. Summarise in 3–5 sentences how the thesis has changed overall.
2. Go through the thesis chapter by chapter and describe what was added, rewritten, moved or removed. Skip layout, formatting and small wording fixes.
3. List the changes that need my attention, for example: changed research questions, method, data, results or conclusions; removed content; new claims without a source; figures or tables that no longer match the text; contradictions between chapters.
4. Say what still looks unfinished in the current draft, such as empty sections, placeholder text or missing references.

For every point, give the section number and the page in the current draft so I can check it. Use the change list as the record of what changed and the PDFs for context. If you are unsure about something, say so instead of guessing.`;
}
export function openComparison(root, { store, report, reports, onError }) {
  const abort = new AbortController(); let docs = [], run = 0, result = null, current = 0, list = [], shown = 0, showMinor = false, baseline = null;
  const choices = thesisBaselines(report, reports);
  root.innerHTML = `<p>Compare this thesis draft with an earlier thesis draft from the same student. Both PDFs are shown side by side: removed text is marked red in the previous draft, added text green in the current one.</p>
    <label class="field"><span>Earlier thesis draft</span><select id="pdf-baseline">${choices.map(r => `<option value="${e(r.id)}">${e(r.title)} · ${e(uploaded(r))} · ${e(r.file_name)}</option>`).join('')}</select></label>
    <p class="small muted">Text comparison ignores line wrapping and repeated headers. Figures, formatting, and scanned pages need a visual check in the original PDFs.</p>
    <div id="pdf-comparison" role="status" aria-live="polite"></div>`;
  const output = root.querySelector('#pdf-comparison'), select = root.querySelector('select');
  let panes = [];
  // Where a change sits in one draft: its own words, or the neighbouring word when that side has none.
  function located(group, side) {
    const own = side === 'old' ? group.removed : group.added;
    if (own.length) return { tokens: own };
    const tokens = docs[side === 'old' ? 0 : 1]?.tokens || [], at = side === 'old' ? group.oldAt : group.newAt;
    return tokens[at] ? { anchor: tokens[at], edge: 'start' } : tokens[at - 1] ? { anchor: tokens[at - 1], edge: 'end' } : {};
  }
  function draw(pane) {
    const ctx = pane.overlay.getContext('2d'), W = pane.overlay.width, H = pane.overlay.height, old = pane.side === 'old';
    ctx.clearRect(0, 0, W, H); if (!result) return;
    const line = Math.max(2, W / 400);
    list.forEach((group, index) => {
      const place = located(group, pane.side), active = index === current;
      for (const r of bands((place.tokens || []).filter(t => t.page === pane.page).flatMap(t => t.boxes))) {
        ctx.fillStyle = old ? (active ? '#dc262666' : '#dc262633') : (active ? '#16a34a66' : '#16a34a33');
        ctx.fillRect(r.x * W, r.y * H, r.w * W, r.h * H);
        if (active) { ctx.strokeStyle = old ? '#b91c1c' : '#15803d'; ctx.lineWidth = line; ctx.strokeRect(r.x * W - line, r.y * H - line, r.w * W + 2 * line, r.h * H + 2 * line); }
      }
      // Text that exists only in the other draft: a caret shows where it was added or removed.
      const box = place.anchor?.page === pane.page && (place.edge === 'start' ? place.anchor.boxes[0] : place.anchor.boxes.at(-1));
      if (active && box) {
        const x = (place.edge === 'start' ? box.x : box.x + box.w) * W;
        ctx.fillStyle = old ? '#15803d' : '#b91c1c'; ctx.fillRect(x - line, box.y * H - 3 * line, 2 * line, box.h * H + 6 * line);
        ctx.fillRect(x - 4 * line, box.y * H - 3 * line, 8 * line, line); ctx.fillRect(x - 4 * line, (box.y + box.h) * H + 2 * line, 8 * line, line);
      }
    });
  }
  function firstBox(pane) {
    const place = list[current] && located(list[current], pane.side);
    if (!place) return null;
    if (place.tokens) return place.tokens.find(t => t.page === pane.page && t.boxes.length)?.boxes[0] || null;
    return place.anchor?.page === pane.page ? place.anchor.boxes[0] || null : null;
  }
  async function renderPane(pane, reveal = false) {
    const seq = ++pane.seq, thisRun = run, doc = docs[pane.index];
    const previous = pane.task; previous?.cancel();
    if (previous) { try { await previous.promise; } catch { /* Cancel before reusing the canvas. */ } }
    if (seq !== pane.seq || thisRun !== run || !doc) return;
    pane.page = Math.max(1, Math.min(doc.pdf.numPages, pane.page));
    pane.label.textContent = `Page ${pane.page} of ${doc.pdf.numPages}`;
    try {
      const page = await doc.pdf.getPage(pane.page);
      if (seq !== pane.seq || thisRun !== run) return;
      const base = page.getViewport({ scale: 1 }), width = Math.max(180, pane.scroll.clientWidth - 16);
      const view = page.getViewport({ scale: width / base.width }), ratio = Math.min(devicePixelRatio || 1, 2, 2400 / view.width, 3200 / view.height);
      pane.canvas.width = Math.ceil(view.width * ratio); pane.canvas.height = Math.ceil(view.height * ratio);
      pane.overlay.width = pane.canvas.width; pane.overlay.height = pane.canvas.height;
      pane.sheet.style.width = `${view.width}px`; pane.sheet.style.height = `${view.height}px`;
      pane.task = page.render({ canvasContext: pane.canvas.getContext('2d'), viewport: view, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      await pane.task.promise;
      if (seq !== pane.seq || thisRun !== run) return;
      draw(pane);
      const box = reveal && firstBox(pane);
      if (box) pane.scroll.scrollTop = Math.max(0, box.y * view.height - 80);
      else if (reveal) pane.scroll.scrollTop = 0;
    } catch (error) { if (error.name !== 'RenderingCancelledException' && thisRun === run) pane.label.textContent = error.message; }
  }
  function show(index) {
    if (!list.length) return;
    current = Math.max(0, Math.min(list.length - 1, index));
    root.querySelector('#diff-position').textContent = `Change ${current + 1} of ${list.length}`;
    root.querySelector('[data-diff=previous]').disabled = current === 0;
    root.querySelector('[data-diff=next]').disabled = current === list.length - 1;
    root.querySelectorAll('.diff-passage').forEach(p => p.classList.toggle('active', Number(p.dataset.change) === current));
    for (const pane of panes) {
      const place = located(list[current], pane.side);
      pane.page = place.tokens?.[0]?.page || place.anchor?.page || pane.page;
      void renderPane(pane, true);
    }
  }
  function more() {
    const html = list.slice(shown, shown + 40).map((g, index) => `<section class="diff-passage" data-change="${shown + index}"><h3><button class="text-button" type="button" data-change-button="${shown + index}">Change ${shown + index + 1} · show in both PDFs</button></h3><p class="small muted">${e(g.before)}${g.before ? ' …' : ''}</p><div class="diff-columns">
      <div class="diff-old"><strong>Previous${pageRange(g.removed)}</strong><p>${g.removed.length ? `<del>${e(g.removed.map(w => w.text).join(' '))}</del>` : 'No removed text'}</p></div>
      <div class="diff-new"><strong>Current${pageRange(g.added)}</strong><p>${g.added.length ? `<ins>${e(g.added.map(w => w.text).join(' '))}</ins>` : 'No added text'}</p></div></div><p class="small muted">${g.after ? '… ' : ''}${e(g.after)}</p></section>`).join('');
    output.querySelector('.diff-results').insertAdjacentHTML('beforeend', html); shown += 40;
    output.querySelector('#pdf-more-changes').hidden = shown >= list.length;
    root.querySelectorAll('.diff-passage').forEach(p => p.classList.toggle('active', Number(p.dataset.change) === current));
  }
  // Counts, navigation and the change list, rebuilt when minor changes are shown or hidden.
  function listChanges() {
    list = showMinor ? result.groups : result.groups.filter(g => !g.minor); current = 0; shown = 0;
    const minor = result.groups.length - result.groups.filter(g => !g.minor).length, count = list.length, words = side => list.reduce((n, g) => n + g[side].length, 0);
    output.querySelector('#diff-counts').innerHTML = `<strong>${plural(count, 'changed passage')}</strong> · <span class="diff-count-added">${plural(words('added'), 'word')} added</span> · <span class="diff-count-removed">${plural(words('removed'), 'word')} removed</span>${minor && !showMinor ? ` · ${plural(minor, 'minor change')} hidden` : ''}`;
    output.querySelector('#diff-navigation').innerHTML = count ? '<div class="diff-nav"><button class="secondary" type="button" data-diff="previous">← Previous change</button><strong id="diff-position"></strong><button class="secondary" type="button" data-diff="next">Next change →</button></div>'
      : `<p>${minor ? 'Only minor changes found: page numbers, numbering, punctuation or capitals.' : 'No text differences found.'} Figures and formatting may still differ; compare the pages below.</p>`;
    output.querySelector('#diff-list').innerHTML = count ? '<h3>All changes</h3><div class="diff-results"></div><button class="secondary" id="pdf-more-changes" type="button" hidden>Show more changes</button>' : '';
    if (count) { more(); show(0); } else for (const p of panes) void renderPane(p);
  }
  const aiFiles = () => [`previous-draft-${fileBase(baseline)}.pdf`, `current-draft-${fileBase(report)}.pdf`, `changes-${fileBase(report)}.txt`];
  // The changes for ChatGPT as plain text, without the minor ones, with the page of each change in both drafts.
  function changeList() {
    const real = result.groups.filter(g => !g.minor), text = tokens => tokens.map(t => t.text).join(' ');
    const page = (g, side) => { const place = located(g, side); return place.tokens?.[0]?.page || place.anchor?.page || '?'; };
    return [`Text changes between two drafts of a thesis`,
      `Previous draft: ${baseline.file_name} (uploaded ${uploaded(baseline)})\nCurrent draft: ${report.file_name} (uploaded ${uploaded(report)})`,
      `${plural(real.length, 'change')}. ${plural(result.groups.length - real.length, 'minor change')} (page numbers, numbering, punctuation, capitals) left out.`,
      ...real.map((g, i) => [`Change ${i + 1} · previous draft page ${page(g, 'old')} · current draft page ${page(g, 'new')}`,
        `Before: ${g.before ? '…' + g.before : '(start of the thesis)'}`, `Removed: ${text(g.removed) || '(nothing)'}`,
        `Added: ${text(g.added) || '(nothing)'}`, `After: ${g.after ? g.after + '…' : '(end of the thesis)'}`].join('\n'))].join('\n\n') + '\n';
  }
  async function forAI(action) {
    if (!result || docs.length < 2) return;
    const files = aiFiles(), status = output.querySelector('#diff-ai-status');
    if (action === 'previous') save(docs[0].bytes, files[0], 'application/pdf');
    if (action === 'current') save(docs[1].bytes, files[1], 'application/pdf');
    if (action === 'changes') save(changeList(), files[2], 'text/plain;charset=utf-8');
    if (action !== 'prompt') return;
    try { await navigator.clipboard.writeText(aiPrompt(files, baseline, report)); status.textContent = 'Prompt copied. Paste it into ChatGPT with the three files attached.'; }
    catch { status.textContent = 'This browser blocked copying. Copy the prompt below by hand.'; output.querySelector('.diff-ai details').open = true; }
  }
  root.addEventListener('click', event => {
    const nav = event.target.closest('[data-diff]'), step = event.target.closest('[data-step]'), change = event.target.closest('[data-change-button]'), ai = event.target.closest('[data-ai]');
    if (nav) show(current + (nav.dataset.diff === 'next' ? 1 : -1));
    if (step) { const pane = panes[Number(step.dataset.pane)]; pane.page += Number(step.dataset.step); void renderPane(pane); }
    if (change) { show(Number(change.dataset.changeButton)); root.querySelector('.diff-nav')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    if (event.target.closest('#pdf-more-changes')) more();
    if (ai) void forAI(ai.dataset.ai);
  });
  root.addEventListener('change', event => { if (event.target.id === 'diff-show-minor' && result) { showMinor = event.target.checked; listChanges(); } });
  const resize = new ResizeObserver(() => { for (const pane of panes) void renderPane(pane); });
  async function release() { const old = docs; docs = []; panes = []; resize.disconnect(); for (const d of old) await d.dispose(); }
  async function compare() {
    const selected = choices.find(r => r.id === select.value), thisRun = ++run;
    await release(); result = null; list = []; current = 0; showMinor = false; baseline = selected;
    if (thisRun !== run) return;
    if (!selected) { output.textContent = 'This is the first uploaded thesis draft. It will be the starting version for the next draft.'; return; }
    select.disabled = true;
    output.textContent = 'Opening the two thesis PDFs…';
    try {
      // Sequential loading makes resource cleanup reliable if one PDF is invalid.
      docs = [await documentPDF(store, selected, abort.signal)];
      docs.push(await documentPDF(store, report, abort.signal));
      const status = message => { if (!abort.signal.aborted && thisRun === run) output.textContent = message; };
      const previous = await words(docs[0].pdf, abort.signal, status), latest = await words(docs[1].pdf, abort.signal, status);
      docs[0].tokens = previous.tokens; docs[1].tokens = latest.tokens;
      if (!previous.tokens.length || !latest.tokens.length) throw new Error('At least one PDF has no extractable text. Scanned PDFs need OCR; no text comparison is available.');
      status('Finding additions and deletions…');
      result = await changes(previous.tokens, latest.tokens, abort.signal);
      if (abort.signal.aborted || thisRun !== run) return;
      const scanned = previous.textPages < docs[0].pdf.numPages || latest.textPages < docs[1].pdf.numPages;
      const minor = result.groups.filter(g => g.minor).length;
      const pane = (side, index, title, file) => `<section class="diff-pane diff-pane-${side}" aria-label="${title} draft">
        <div class="diff-pane-head"><span class="diff-pane-title"><strong>${title}</strong> <span class="small muted">${e(file)}</span></span>
        <span class="diff-pane-pages"><button class="secondary" type="button" data-pane="${index}" data-step="-1" aria-label="Previous page of the ${title.toLowerCase()} draft">←</button><span class="diff-page-label small"></span><button class="secondary" type="button" data-pane="${index}" data-step="1" aria-label="Next page of the ${title.toLowerCase()} draft">→</button></span></div>
        <div class="diff-scroll"><div class="pdf-sheet"><canvas aria-label="${title} draft page"></canvas><canvas class="pdf-overlay diff-overlay" aria-hidden="true"></canvas></div></div></section>`;
      const button = (action, label) => `<button class="secondary small-button" type="button" data-ai="${action}">${label}</button>`;
      output.innerHTML = `${scanned ? '<p class="notice amber">Some pages have no extractable text and are not covered by this text comparison. Check those pages in the originals.</p>' : ''}<div class="diff-summary"><p id="diff-counts"></p>${minor ? `<label class="diff-minor-toggle small"><input type="checkbox" id="diff-show-minor"> Show ${plural(minor, 'minor change')} (page numbers, numbering, punctuation, capitals)</label>` : ''}</div>
        <section class="diff-ai" aria-labelledby="diff-ai-title"><h3 id="diff-ai-title">Review with ChatGPT</h3>
        <p class="small muted">Ask ChatGPT for an overview of what changed, then check the details in the comparison below. Use your TalTech ChatGPT account: these files contain the student’s unpublished thesis.</p>
        <ol><li><a class="secondary small-button" href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer">Open ChatGPT ↗</a></li>
        <li>Download the three files and attach them in ChatGPT:<div class="diff-ai-buttons">${button('previous', 'Previous draft PDF')}${button('current', 'Current draft PDF')}${button('changes', 'Change list (.txt)')}</div></li>
        <li><div class="diff-ai-buttons"><button class="primary small-button" type="button" data-ai="prompt">Copy prompt</button><span>and paste it into ChatGPT.</span></div><p id="diff-ai-status" class="small" role="status"></p></li></ol>
        <details><summary class="small">Show the prompt</summary><pre class="diff-ai-prompt">${e(aiPrompt(aiFiles(), selected, report))}</pre></details></section>
        <div id="diff-navigation"></div>
        <div class="diff-panes">${pane('old', 0, 'Previous', selected.file_name)}${pane('new', 1, 'Current', report.file_name)}</div>
        <p class="diff-legend small"><span class="diff-key removed"></span>Removed from the previous draft <span class="diff-key added"></span>Added in the current draft · The selected change is outlined; a bar marks where text exists in only one draft.</p>
        <div id="diff-list"></div>`;
      panes = [...output.querySelectorAll('.diff-pane')].map((el, index) => ({ el, index, side: index ? 'new' : 'old', page: 1, seq: 0, task: null,
        canvas: el.querySelector('canvas'), overlay: el.querySelector('.diff-overlay'), sheet: el.querySelector('.pdf-sheet'), scroll: el.querySelector('.diff-scroll'), label: el.querySelector('.diff-page-label') }));
      for (const p of panes) resize.observe(p.scroll);
      listChanges();
    } catch (error) { if (!abort.signal.aborted && thisRun === run) { output.textContent = error.message; onError?.(error); await release(); } }
    finally { if (!abort.signal.aborted && thisRun === run) select.disabled = false; }
  }
  select.addEventListener('change', compare); void compare();
  return { canClose: () => true, dispose: () => { run++; abort.abort(); for (const p of panes) p.task?.cancel(); void release(); } };
}

export function openReview(root, { store, report, readonly, onShared, onError }) {
  const abort = new AbortController(); let doc, marks = [], original = '[]', revision = 0;
  let pageNumber = 1, zoom = 1, tool = 'highlight', selected = null, drag = null, rendering = null, renderingPage = 0, disposed = false, saving = false;
  root.innerHTML = `<p>${readonly ? 'Your supervisor’s highlights and comments on this submission.' : 'Highlight a region by dragging on the PDF. Click a point with the Comment tool to attach a note. Share when your review is ready.'}</p>
    <div class="pdf-toolbar"><button class="secondary" data-pdf="previous" aria-label="Previous PDF page">←</button><label class="pdf-page-label">Page <input id="pdf-page-number" type="number" min="1" value="1" aria-label="PDF page number"></label><span id="pdf-pages"></span><button class="secondary" data-pdf="next" aria-label="Next PDF page">→</button>
    <label class="pdf-zoom-label">Zoom <select id="pdf-zoom"><option value="1">Fit width</option><option value="1.5">150%</option><option value="2">200%</option><option value="3">300%</option><option value="4">400%</option></select></label>
    ${!readonly ? '<button class="secondary" data-pdf="read" aria-pressed="false">Read / scroll</button><button class="secondary" data-pdf="highlight" aria-pressed="true">Highlight</button><button class="secondary" data-pdf="comment" aria-pressed="false">Comment</button><button class="secondary" data-pdf="page-comment">Add page comment</button>' : ''}<button class="secondary" data-pdf="download">Download reviewed PDF</button></div>
    <p id="pdf-status" role="status" aria-live="polite">Opening PDF…</p>
    <div class="pdf-review-layout"><div class="pdf-stage"><div class="pdf-sheet"><canvas aria-label="Submitted PDF page"></canvas><canvas class="pdf-overlay" aria-label="PDF highlights and comment markers"></canvas></div></div>
      <aside class="pdf-feedback"><h3>PDF feedback</h3><div id="pdf-mark-list"></div>${!readonly ? '<form id="pdf-note-form" hidden><label class="field"><span>Comment on this mark</span><textarea id="pdf-note" rows="4" maxlength="2000"></textarea></label><button class="secondary" type="submit">Save comment</button></form><button class="primary full" data-pdf="share">Share PDF feedback</button><p id="pdf-save-status" class="small muted">Changes stay in this view until you share them.</p>' : ''}</aside></div>`;
  const canvas = root.querySelector('canvas'), overlay = root.querySelector('.pdf-overlay'), sheet = root.querySelector('.pdf-sheet');
  const status = root.querySelector('#pdf-status'), pageInput = root.querySelector('#pdf-page-number');
  const controls = () => root.querySelectorAll('.pdf-toolbar button, .pdf-toolbar input, .pdf-toolbar select, [data-pdf="share"], #pdf-note, #pdf-note-form button');
  controls().forEach(b => { b.disabled = true; });
  const dirty = () => JSON.stringify(marks) !== original;
  function draw() {
    const ratio = overlay.width / (parseFloat(sheet.style.width) || overlay.width || 1);
    const ctx = overlay.getContext('2d'); ctx.clearRect(0, 0, overlay.width, overlay.height);
    const list = drag ? [...marks, { ...drag.rect, type: 'highlight', page: pageNumber }] : marks;
    for (const m of list) {
      if (m.page !== pageNumber) continue;
      const x = m.x * overlay.width, y = m.y * overlay.height;
      if (m.type === 'highlight') { ctx.fillStyle = '#ffd53f66'; ctx.fillRect(x, y, m.w * overlay.width, m.h * overlay.height); }
      if (m.type === 'comment' || m.text) {
        ctx.fillStyle = '#0f766e'; ctx.beginPath(); ctx.arc(x, y, 13 * ratio, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'white'; ctx.font = `bold ${13 * ratio}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(marks.indexOf(m) + 1), x, y);
      }
      if (m.id === selected) { ctx.strokeStyle = '#0f766e'; ctx.lineWidth = 2 * ratio; ctx.strokeRect(x, y, Math.max(m.w * overlay.width, 24), Math.max(m.h * overlay.height, 24)); }
    }
  }
  function feedback() {
    // Marks that differ from what the student can already see are labelled, so new feedback is easy to spot.
    const shared = new Map(JSON.parse(original).map(m => [m.id, m.text]));
    root.querySelector('#pdf-mark-list').innerHTML = marks.length ? marks.map((m, i) => `<div class="pdf-mark${m.id === selected ? ' selected' : ''}"><button class="text-button" data-mark="${e(m.id)}">${i + 1}. ${m.type === 'highlight' ? 'Highlight' : 'Comment'} · page ${m.page}</button>${!readonly && shared.get(m.id) !== m.text ? ' <span class="badge amber">Not shared yet</span>' : ''}<p class="prose">${e(m.text || 'Highlighted region')}</p>${!readonly ? `<button class="text-button danger" data-remove="${e(m.id)}" aria-label="Remove annotation ${i + 1}">Remove</button>` : ''}</div>`).join('') : '<p class="muted">No PDF annotations yet.</p>';
    if (!readonly) root.querySelector('#pdf-save-status').textContent = dirty() ? 'Unshared changes. Select Share PDF feedback when ready.' : revision ? 'This PDF feedback is shared with the student.' : 'Changes stay in this view until you share them.';
    draw();
  }
  async function renderPage() {
    if (!doc || disposed) return;
    renderingPage++;
    const seq = renderingPage;
    const previous = rendering; previous?.cancel();
    if (previous) { try { await previous.promise; } catch { /* Cancel before reusing the canvas. */ } }
    if (seq !== renderingPage || disposed) return;
    pageNumber = Math.max(1, Math.min(doc.pdf.numPages, pageNumber)); pageInput.value = pageNumber;
    status.textContent = 'Rendering page…'; overlay.style.pointerEvents = 'none';
    try {
      const page = await doc.pdf.getPage(pageNumber);
      if (seq !== renderingPage || disposed) return;
      const viewport = page.getViewport({ scale: 1 });
      const width = Math.min(root.querySelector('.pdf-stage').clientWidth - 24, 850) * zoom;
      const scale = Math.max(180, width) / viewport.width;
      const view = page.getViewport({ scale }), ratio = Math.min(devicePixelRatio || 1, 2, 2400 / view.width, 3200 / view.height);
      canvas.width = Math.ceil(view.width * ratio); canvas.height = Math.ceil(view.height * ratio);
      overlay.width = canvas.width; overlay.height = canvas.height;
      sheet.style.width = `${view.width}px`; sheet.style.height = `${view.height}px`;
      rendering = page.render({ canvasContext: canvas.getContext('2d'), viewport: view, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      await rendering.promise;
      if (seq !== renderingPage || disposed) return;
      draw(); overlay.style.pointerEvents = readonly || tool === 'read' ? 'none' : 'auto';
      status.textContent = `Page ${pageNumber} of ${doc.pdf.numPages}${readonly ? ' · Shared PDF feedback' : ` · ${tool === 'highlight' ? 'Drag to highlight' : tool === 'comment' ? 'Click to comment' : 'Scroll to read'}`}`;
    } catch (error) { if (!disposed && error.name !== 'RenderingCancelledException') status.textContent = error.message; }
  }
  // A comment click that never got any text is dropped as soon as the reviewer moves on.
  function dropEmpty(keep = null) {
    const before = marks.length;
    marks = marks.filter(m => m.id === keep || m.type !== 'comment' || m.text.trim());
    if (marks.length === before) return;
    if (!marks.some(m => m.id === selected)) { selected = null; root.querySelector('#pdf-note-form').hidden = true; }
    feedback();
  }
  function choose(id) {
    if (!readonly) dropEmpty(id);
    selected = id; const mark = marks.find(m => m.id === id); if (!mark) return;
    if (!readonly) {
      root.querySelector('#pdf-note-form').hidden = false; root.querySelector('#pdf-note').value = mark.text;
      root.querySelector('#pdf-note-form .field span').textContent = `${mark.type === 'highlight' ? 'Comment on highlight' : 'Comment'} ${marks.indexOf(mark) + 1} · page ${mark.page}`;
      feedback();
    }
    pageNumber = mark.page; void renderPage();
  }
  function add(mark) {
    dropEmpty();
    if (marks.length >= 200) { onError(new Error('Use at most 200 annotations per PDF.')); return; }
    mark.id = crypto.randomUUID(); mark.text ||= ''; marks.push(mark); selected = mark.id;
    feedback(); choose(mark.id); if (mark.type === 'comment') root.querySelector('#pdf-note').focus();
  }
  const point = event => { const r = overlay.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (event.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (event.clientY - r.top) / r.height)) }; };
  overlay.addEventListener('pointerdown', event => {
    if (readonly || saving || tool === 'read' || !doc || event.button !== 0) return;
    const p = point(event); event.preventDefault();
    if (tool === 'comment') { add({ ...p, w: 0, h: 0, type: 'comment', page: pageNumber }); return; }
    overlay.setPointerCapture(event.pointerId); drag = { start: p, rect: { ...p, w: 0, h: 0 } }; draw();
  });
  overlay.addEventListener('pointermove', event => {
    if (!drag) return; const p = point(event), s = drag.start;
    drag.rect = { x: Math.min(p.x, s.x), y: Math.min(p.y, s.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) }; draw();
  });
  overlay.addEventListener('pointerup', () => { if (!drag) return; const rect = drag.rect; drag = null; if (rect.w > .005 && rect.h > .003) add({ ...rect, type: 'highlight', page: pageNumber }); else draw(); });
  overlay.addEventListener('pointercancel', () => { drag = null; draw(); });
  root.addEventListener('click', async event => {
    const mark = event.target.closest('[data-mark]'), remove = event.target.closest('[data-remove]');
    if (mark) return choose(mark.dataset.mark);
    if (remove && !readonly && !saving) { marks = marks.filter(m => m.id !== remove.dataset.remove); selected = null; root.querySelector('#pdf-note-form').hidden = true; feedback(); return; }
    const button = event.target.closest('[data-pdf]'); if (!button || !doc || saving) return;
    const action = button.dataset.pdf;
    if (action === 'previous' || action === 'next') { pageNumber += action === 'next' ? 1 : -1; return void renderPage(); }
    if (['read','highlight','comment'].includes(action) && !readonly) {
      tool = action; root.querySelectorAll('[aria-pressed]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.pdf === tool)));
      overlay.style.touchAction = tool === 'highlight' ? 'none' : 'auto'; return void renderPage();
    }
    if (action === 'page-comment' && !readonly) return add({ type: 'comment', page: pageNumber, x: .06, y: .06, w: 0, h: 0 });
    if (action === 'share' && !readonly) {
      try {
        // Include the currently edited note so Share cannot discard text still in the field.
        const edited = marks.find(m => m.id === selected); if (edited) edited.text = root.querySelector('#pdf-note').value.trim();
        dropEmpty(); validAnnotations(marks, doc.pdf.numPages); saving = true; controls().forEach(b => { b.disabled = true; });
        const saved = await store.sharePdfReview(report.id, marks, revision);
        revision = saved.revision; original = JSON.stringify(marks); feedback(); onShared(saved);
      } catch (error) { onError(error); }
      finally { saving = false; if (!disposed) controls().forEach(b => { b.disabled = false; }); }
    }
    if (action === 'download') {
      button.disabled = true;
      try {
        if (!readonly) dropEmpty();
        const copy = structuredClone(marks).map(m => ({ ...m, text: m.text.trim() }));
        validAnnotations(copy, doc.pdf.numPages); await downloadReview(doc, copy, report.file_name);
      }
      catch (error) { onError(error); }
      finally { if (!disposed) button.disabled = false; }
    }
  });
  pageInput.addEventListener('change', () => { pageNumber = Number(pageInput.value) || 1; void renderPage(); });
  root.querySelector('#pdf-zoom').addEventListener('change', event => { zoom = Number(event.target.value); void renderPage(); });
  root.querySelector('#pdf-note-form')?.addEventListener('submit', event => {
    event.preventDefault(); const mark = marks.find(m => m.id === selected); if (!mark || saving) return;
    mark.text = root.querySelector('#pdf-note').value.trim();
    // Saving finishes editing this mark: close the box so the saved text does not look like a new comment.
    selected = null; root.querySelector('#pdf-note-form').hidden = true; dropEmpty(); feedback();
    root.querySelector('#pdf-save-status').textContent = 'Comment saved. Select Share PDF feedback to send it to the student.';
  });
  root.querySelector('#pdf-note')?.addEventListener('input', () => { const m = marks.find(m => m.id === selected); if (m && !saving) { m.text = root.querySelector('#pdf-note').value; root.querySelector('#pdf-save-status').textContent = 'Unshared changes.'; } });
  const resize = new ResizeObserver(() => { if (doc) void renderPage(); }); resize.observe(root.querySelector('.pdf-stage'));
  const unload = event => { if (!readonly && dirty()) { event.preventDefault(); event.returnValue = ''; } };
  window.addEventListener('beforeunload', unload);
  void (async () => {
    try {
      const review = await store.pdfReview(report.id); if (disposed) return;
      doc = await documentPDF(store, report, abort.signal); if (disposed) { await doc.dispose(); return; }
      marks = structuredClone(review?.annotations || []); validAnnotations(marks, doc.pdf.numPages);
      original = JSON.stringify(marks); revision = review?.revision || 0;
      pageInput.max = doc.pdf.numPages; root.querySelector('#pdf-pages').textContent = `of ${doc.pdf.numPages}`;
      controls().forEach(b => { b.disabled = false; }); feedback(); await renderPage();
    } catch (error) { if (!disposed) { status.textContent = error.message; onError(error); } }
  })();
  return {
    canClose: () => !saving && (readonly || !dirty() || confirm('Discard PDF feedback that has not been shared?')),
    dispose: () => { disposed = true; abort.abort(); rendering?.cancel(); resize.disconnect(); window.removeEventListener('beforeunload', unload); if (doc) void doc.dispose(); }
  };
}
// Fit text to a standard PDF font: characters it cannot draw (e.g. Cyrillic) become "?". The note
// annotation keeps the full text; this only affects the printed summary.
function printable(text, font) {
  const supported = new Set(font.getCharacterSet());
  return [...text.replace(/\r\n?/g, '\n')].map(c => c === '\n' || supported.has(c.codePointAt(0)) ? c : '?').join('');
}
function wrap(text, font, size, width) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (let word of paragraph.split(/\s+/).filter(Boolean)) {
      // Break words longer than a line, such as URLs.
      while (font.widthOfTextAtSize(word, size) > width) {
        let cut = word.length - 1; while (cut > 1 && font.widthOfTextAtSize(word.slice(0, cut), size) > width) cut--;
        if (line) { lines.push(line); line = ''; }
        lines.push(word.slice(0, cut)); word = word.slice(cut);
      }
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width) { lines.push(line); line = word; } else line = next;
    }
    lines.push(line);
  }
  return lines;
}
async function downloadReview(doc, marks, name) {
  const { pdfLib } = await libs();
  const { PDFDocument, PDFName, PDFHexString, PDFArray, StandardFonts, rgb } = pdfLib;
  const pdf = await PDFDocument.load(doc.bytes), pages = pdf.getPages();
  const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const teal = rgb(0.06, 0.46, 0.43);
  for (const [index, mark] of marks.entries()) {
    const page = pages[mark.page - 1], source = await doc.pdf.getPage(mark.page);
    const viewport = source.getViewport({ scale: 1 });
    const point = (x, y) => viewport.convertToPdfPoint(x * viewport.width, y * viewport.height);
    const a = point(mark.x, mark.y), b = point(mark.x + mark.w, mark.y + mark.h);
    const rect = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    if (mark.type === 'highlight') page.drawRectangle({ x: rect[0], y: rect[1], width: rect[2] - rect[0], height: rect[3] - rect[1], color: rgb(1, .84, .15), opacity: .3 });
    if (mark.text) {
      // A numbered marker printed on the page, matching the summary page, so every viewer shows it.
      const label = String(index + 1), size = 9, box = page.getMediaBox();
      const cx = Math.min(Math.max(a[0], box.x + 10), box.x + box.width - 10), cy = Math.min(Math.max(a[1], box.y + 10), box.y + box.height - 10);
      page.drawCircle({ x: cx, y: cy, size: 9, color: teal });
      page.drawText(label, { x: cx - bold.widthOfTextAtSize(label, size) / 2, y: cy - size * .35, size, font: bold, color: rgb(1, 1, 1) });
      // The note annotation also opens as a comment in viewers that support them (Acrobat, Preview).
      const note = pdf.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [a[0], a[1] - 20, a[0] + 20, a[1]],
        Contents: PDFHexString.fromText(mark.text), T: PDFHexString.fromText('Supervisor feedback'), Name: 'Comment', C: [0.06, 0.46, 0.43], F: 4 });
      // Most pages have no annotation list yet; lookup() would throw, lookupMaybe() returns undefined.
      let annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
      if (!annots) { annots = pdf.context.obj([]); page.node.set(PDFName.of('Annots'), annots); }
      annots.push(pdf.context.register(note));
    }
  }
  if (marks.length) {
    // Summary pages: every comment in full, numbered like the markers on the PDF.
    const [width, height] = [595.28, 841.89], margin = 56, textWidth = width - 2 * margin;
    let page = pdf.addPage([width, height]), y = height - margin;
    const line = (text, options) => {
      if (y < margin + options.size) { page = pdf.addPage([width, height]); y = height - margin; }
      page.drawText(text, { x: margin + (options.indent || 0), y, ...options }); y -= options.size * 1.45;
    };
    line('Supervisor feedback', { size: 18, font: bold, color: teal }); y -= 4;
    for (const text of wrap(printable(name || 'submission.pdf', font), font, 10, textWidth)) line(text, { size: 10, font, color: rgb(.35, .4, .45) });
    y -= 10;
    for (const [index, mark] of marks.entries()) {
      line(`${index + 1}  ·  Page ${mark.page}  ·  ${mark.type === 'highlight' ? 'Highlight' : 'Comment'}`, { size: 11, font: bold, color: teal });
      for (const text of wrap(printable(mark.text || 'Highlighted region (no comment)', font), font, 11, textWidth - 14)) line(text, { size: 11, font, indent: 14 });
      y -= 8;
    }
  }
  const bytes = await pdf.save(); const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const link = document.createElement('a'); link.href = url; link.download = (name || 'submission.pdf').replace(/\.pdf$/i, '') + '-reviewed.pdf'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
