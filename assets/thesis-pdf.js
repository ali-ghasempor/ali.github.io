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
  for (const m of marks) {
    if (!m || typeof m.id !== 'string' || !m.id || m.id.length > 80 || ids.has(m.id) ||
      !['highlight','comment'].includes(m.type) || !Number.isInteger(m.page) || m.page < 1 || m.page > pages ||
      typeof m.text !== 'string' || m.text.length > 2000 || (m.type === 'comment' && !m.text.trim()) ||
      !['x','y','w','h'].every(k => Number.isFinite(m[k]) && m[k] >= 0 && m[k] <= 1) ||
      m.x + m.w > 1.001 || m.y + m.h > 1.001) throw new Error('Invalid PDF annotation.');
    ids.add(m.id);
  }
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
// Compare words across the whole document, rather than page-by-page: an added
// paragraph should not flag every following page when pagination shifts.
async function words(document, signal, status) {
  const lines = [], edges = new Map(); let count = 0, textPages = 0;
  for (let page = 1; page <= document.numPages; page++) {
    if (signal.aborted) throw new DOMException('Closed', 'AbortError');
    status(`Reading page ${page} of ${document.numPages}…`);
    const p = await document.getPage(page), content = await p.getTextContent();
    const height = p.view[3] - p.view[1];
    if (content.items.some(i => i.str?.trim())) textPages++;
    for (const item of content.items) {
      if (!item.str?.trim()) continue;
      const text = item.str.normalize('NFKC').replace(/\u00ad/g, '').trim();
      const edge = p.rotate % 180 === 0 && (item.transform[5] - p.view[1] < height * 0.06 || item.transform[5] - p.view[1] > height * 0.94);
      if (edge) { const key = text.replace(/\d+/g, '#'); if (!edges.has(key)) edges.set(key, new Set()); edges.get(key).add(page); }
      lines.push({ text, page, edge, eol: item.hasEOL });
      count += text.split(/\s+/).length;
      if (count > MAX_WORDS) throw new Error('This PDF has too much text for browser comparison. Compare a shorter draft.');
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  const tokens = [];
  for (const line of lines) {
    // Ignore repeated running headers and footers, including changing page numbers.
    if (document.numPages > 1 && line.edge && edges.get(line.text.replace(/\d+/g, '#'))?.size >= Math.max(2, Math.ceil(document.numPages * .5))) continue;
    const parts = line.text.split(/\s+/);
    if (tokens.at(-1)?.join) { const last = tokens.at(-1); last.text = last.text.slice(0, -1) + parts.shift(); delete last.join; }
    for (const text of parts) tokens.push({ text, page: line.page });
    if (line.eol && /[\p{L}]-$/u.test(parts.at(-1) || '')) tokens.at(-1).join = true;
  }
  return { tokens, textPages };
}
async function changes(before, after) {
  const { diff } = await libs();
  const parts = await new Promise(resolve => diff.diffArrays(before.map(w => w.text), after.map(w => w.text), {
    timeout: 8000, maxEditLength: 20000, callback: resolve
  }));
  if (!parts) throw new Error('These drafts differ too much for a quick browser comparison. Try a nearer version.');
  const groups = []; let old = 0, current = 0, added = 0, removed = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part.added && !part.removed) { old += part.count; current += part.count; continue; }
    const group = { before: before.slice(Math.max(0, old - 12), old).map(t => t.text).join(' '), removed: [], added: [] };
    while (i < parts.length && (parts[i].added || parts[i].removed)) {
      const next = parts[i];
      if (next.removed) { group.removed.push(...before.slice(old, old + next.count)); old += next.count; removed += next.count; }
      else { group.added.push(...after.slice(current, current + next.count)); current += next.count; added += next.count; }
      i++;
    }
    group.after = after.slice(current, current + 12).map(t => t.text).join(' ');
    groups.push(group); i--;
  }
  return { groups, added, removed };
}
export function openComparison(root, { store, report, reports }) {
  const abort = new AbortController(); let docs = [], run = 0;
  const choices = thesisBaselines(report, reports);
  root.innerHTML = `<p>Compare the text of this thesis draft with an earlier thesis draft from the same student.</p>
    <label class="field"><span>Earlier thesis draft</span><select id="pdf-baseline">${choices.map(r => `<option value="${e(r.id)}">${e(r.title)} · ${e(new Date(r.created_at).toLocaleString('en-GB', { timeZone: 'Europe/Tallinn' }))} · ${e(r.file_name)}</option>`).join('')}</select></label>
    <p class="small muted">Text comparison ignores line wrapping and repeated headers. Figures, formatting, and scanned pages need a visual check in the original PDFs.</p>
    <div id="pdf-comparison" role="status" aria-live="polite"></div>`;
  const output = root.querySelector('#pdf-comparison');
  async function compare() {
    const selected = choices.find(r => r.id === root.querySelector('select').value), thisRun = ++run;
    if (!selected) { output.textContent = 'This is the first uploaded thesis draft. It will be the starting version for the next draft.'; return; }
    root.querySelector('select').disabled = true;
    output.textContent = 'Opening the two thesis PDFs…';
    try {
      // Sequential loading makes resource cleanup reliable if one PDF is invalid.
      docs = [await documentPDF(store, selected, abort.signal)];
      docs.push(await documentPDF(store, report, abort.signal));
      const status = message => { if (!abort.signal.aborted && thisRun === run) output.textContent = message; };
      const previous = await words(docs[0].pdf, abort.signal, status), latest = await words(docs[1].pdf, abort.signal, status);
      if (!previous.tokens.length || !latest.tokens.length) throw new Error('At least one PDF has no extractable text. Scanned PDFs need OCR; no text comparison is available.');
      status('Finding additions and deletions…');
      const result = await changes(previous.tokens, latest.tokens);
      if (abort.signal.aborted || thisRun !== run) return;
      const scanned = previous.textPages < docs[0].pdf.numPages || latest.textPages < docs[1].pdf.numPages;
      output.innerHTML = `${scanned ? '<p class="notice amber">Some pages have no extractable text and are not covered by this text comparison. Check those pages in the originals.</p>' : ''}<p class="diff-summary"><strong>${result.groups.length} changed passages</strong> · <span>${result.added} words added</span> · <span>${result.removed} words removed</span></p>
        <p class="small muted">Old: ${e(selected.file_name)} · New: ${e(report.file_name)}</p><div class="diff-results"></div>${result.groups.length ? '<button class="secondary" id="pdf-more-changes" type="button">Show more changes</button>' : '<p>No text differences found. Figures and formatting may still differ.</p>'}`;
      let shown = 0;
      function more() {
        const html = result.groups.slice(shown, shown + 40).map((g, index) => `<section class="diff-passage"><h3>Change ${shown + index + 1}</h3><p class="small muted">${e(g.before)}${g.before ? ' …' : ''}</p><div class="diff-columns">
          <div class="diff-old"><strong>Previous${g.removed.length ? ' · page ' + g.removed[0].page + (g.removed.at(-1).page !== g.removed[0].page ? '–' + g.removed.at(-1).page : '') : ''}</strong><p>${g.removed.length ? `<del>${e(g.removed.map(w => w.text).join(' '))}</del>` : 'No removed text'}</p></div>
          <div class="diff-new"><strong>Current${g.added.length ? ' · page ' + g.added[0].page + (g.added.at(-1).page !== g.added[0].page ? '–' + g.added.at(-1).page : '') : ''}</strong><p>${g.added.length ? `<ins>${e(g.added.map(w => w.text).join(' '))}</ins>` : 'No added text'}</p></div></div><p class="small muted">${g.after ? '… ' : ''}${e(g.after)}</p></section>`).join('');
        output.querySelector('.diff-results').insertAdjacentHTML('beforeend', html); shown += 40;
        if (output.querySelector('#pdf-more-changes')) output.querySelector('#pdf-more-changes').hidden = shown >= result.groups.length;
      }
      output.querySelector('#pdf-more-changes')?.addEventListener('click', more); more();
    } catch (error) { if (!abort.signal.aborted) output.textContent = error.message; }
    finally { for (const d of docs) await d.dispose(); docs = []; if (!abort.signal.aborted) root.querySelector('select').disabled = false; }
  }
  root.querySelector('select').addEventListener('change', compare); void compare();
  return { canClose: () => true, dispose: () => { run++; abort.abort(); } };
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
    root.querySelector('#pdf-mark-list').innerHTML = marks.length ? marks.map((m, i) => `<div class="pdf-mark"><button class="text-button" data-mark="${e(m.id)}">${i + 1}. ${m.type === 'highlight' ? 'Highlight' : 'Comment'} · page ${m.page}</button><p class="prose">${e(m.text || 'Highlighted region')}</p>${!readonly ? `<button class="text-button danger" data-remove="${e(m.id)}" aria-label="Remove annotation ${i + 1}">Remove</button>` : ''}</div>`).join('') : '<p class="muted">No PDF annotations yet.</p>';
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
  function choose(id) {
    selected = id; const mark = marks.find(m => m.id === id); if (!mark) return;
    if (!readonly) { root.querySelector('#pdf-note-form').hidden = false; root.querySelector('#pdf-note').value = mark.text; }
    pageNumber = mark.page; void renderPage();
  }
  function add(mark) {
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
        validAnnotations(marks, doc.pdf.numPages); saving = true; controls().forEach(b => { b.disabled = true; });
        const saved = await store.sharePdfReview(report.id, marks, revision);
        revision = saved.revision; original = JSON.stringify(marks); feedback(); onShared(saved);
      } catch (error) { onError(error); }
      finally { saving = false; if (!disposed) controls().forEach(b => { b.disabled = false; }); }
    }
    if (action === 'download') {
      button.disabled = true;
      try { validAnnotations(marks, doc.pdf.numPages); await downloadReview(doc, structuredClone(marks), report.file_name); }
      catch (error) { onError(error); }
      finally { if (!disposed) button.disabled = false; }
    }
  });
  pageInput.addEventListener('change', () => { pageNumber = Number(pageInput.value) || 1; void renderPage(); });
  root.querySelector('#pdf-zoom').addEventListener('change', event => { zoom = Number(event.target.value); void renderPage(); });
  root.querySelector('#pdf-note-form')?.addEventListener('submit', event => {
    event.preventDefault(); const mark = marks.find(m => m.id === selected); if (!mark || saving) return;
    mark.text = root.querySelector('#pdf-note').value.trim(); feedback();
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
async function downloadReview(doc, marks, name) {
  const { pdfLib } = await libs();
  const { PDFDocument, PDFName, PDFHexString, PDFArray, rgb } = pdfLib;
  const pdf = await PDFDocument.load(doc.bytes); const pages = pdf.getPages();
  for (const mark of marks) {
    const page = pages[mark.page - 1], source = await doc.pdf.getPage(mark.page);
    const viewport = source.getViewport({ scale: 1 });
    const point = (x, y) => viewport.convertToPdfPoint(x * viewport.width, y * viewport.height);
    const a = point(mark.x, mark.y), b = point(mark.x + mark.w, mark.y + mark.h);
    const rect = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    if (mark.type === 'highlight') page.drawRectangle({ x: rect[0], y: rect[1], width: rect[2] - rect[0], height: rect[3] - rect[1], color: rgb(1, .84, .15), opacity: .3 });
    if (mark.text) {
      const note = pdf.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [a[0], a[1] - 20, a[0] + 20, a[1]],
        Contents: PDFHexString.fromText(mark.text), T: PDFHexString.fromText('Supervisor feedback'), Name: 'Comment', C: [0.06, 0.46, 0.43], F: 4 });
      let annots = page.node.lookup(PDFName.of('Annots'), PDFArray);
      if (!annots) { annots = pdf.context.obj([]); page.node.set(PDFName.of('Annots'), annots); }
      annots.push(pdf.context.register(note));
    }
  }
  const bytes = await pdf.save(); const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const link = document.createElement('a'); link.href = url; link.download = (name || 'submission.pdf').replace(/\.pdf$/i, '') + '-reviewed.pdf'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
