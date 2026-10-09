// Shared by the browser download and the private Windows backup tool. No credentials here.
export const BACKUP_VERSION = 1;
export const WORKSPACE_TABLES = ['profiles', 'reports', 'comments', 'tasks', 'slots', 'reviews'];
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const tableName = name => name === 'reviews' ? 'thesis_pdf_reviews' : `thesis_${name}`;
export { tableName };
const json = value => encoder.encode(JSON.stringify(value, null, 2) + '\n');
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export async function sha256(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}
function safePath(path) {
  if (typeof path !== 'string' || !path || path.length > 1000 || /[\\\x00-\x1f:]/.test(path) || path.startsWith('/') || path.split('/').some(p => !p || p === '.' || p === '..'))
    throw new Error('An unsafe archive path was rejected.');
  return path;
}
function indexRows(rows, field = 'id') {
  if (!Array.isArray(rows)) throw new Error('Backup records are unavailable.');
  const keys = rows.map(row => row[field]);
  if (keys.some(key => typeof key !== 'string' || !key) || new Set(keys).size !== keys.length) throw new Error('Backup contains duplicate or invalid record IDs.');
  return new Set(keys);
}
export function validateWorkspace(workspace, files) {
  const profiles = indexRows(workspace.profiles), reports = indexRows(workspace.reports);
  for (const name of WORKSPACE_TABLES) indexRows(workspace[name], name === 'reviews' ? 'report_id' : 'id');
  const objects = new Map();
  for (const file of files) {
    safePath(file.path);
    if (objects.has(file.path) || (file.size !== null && (!Number.isSafeInteger(file.size) || file.size < 0))) throw new Error('Invalid PDF storage inventory.');
    objects.set(file.path, file);
  }
  for (const row of workspace.reports) {
    if (!profiles.has(row.student_id)) throw new Error('A progress update has no student profile.');
    if (row.file_path && (!objects.has(row.file_path) || !Number.isSafeInteger(row.file_size) || row.file_size < 1)) throw new Error('An uploaded PDF is missing from storage. Backup stopped.');
    if (row.file_path && objects.get(row.file_path).size !== null && objects.get(row.file_path).size !== row.file_size) throw new Error('A PDF size does not match its submission. Backup stopped.');
  }
  for (const row of workspace.comments) if (!reports.has(row.report_id) || !profiles.has(row.author_id)) throw new Error('Feedback has a missing record reference.');
  for (const row of workspace.tasks) if (!profiles.has(row.student_id) || !profiles.has(row.created_by)) throw new Error('A next step has a missing profile.');
  for (const row of workspace.slots) if (row.booked_by && !profiles.has(row.booked_by)) throw new Error('A meeting has a missing student profile.');
  for (const row of workspace.reviews) {
    if (!reports.has(row.report_id) || !profiles.has(row.reviewer_id) || !Array.isArray(row.annotations) || !workspace.reports.find(r => r.id === row.report_id)?.file_path) throw new Error('PDF feedback is incomplete.');
  }
}
export function assertUnchanged(before, after) {
  if (canonical(before) !== canonical(after)) throw new Error('The workspace changed during backup. No complete backup was created; try again when uploads and editing have finished.');
}
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
function header(length, signature) { const bytes = new Uint8Array(length); view(bytes).setUint32(0, signature, true); return bytes; }
// Stored ZIP entries avoid a CDN/library and keep already-compressed PDF bytes unchanged.
// ZIP32 limits are checked before writing; Windows writes sequentially rather than holding the ZIP in RAM.
export class ZipWriter {
  constructor(write, maxBytes = 0xffffffff - 65536) { this.write = write; this.maxBytes = maxBytes; this.offset = 0; this.entries = []; this.paths = new Set(); }
  async chunk(bytes) { if (this.offset + bytes.length > this.maxBytes) throw new Error('This archive is too large for one ZIP. Use a smaller archive or a separate database/file backup.'); await this.write(bytes); this.offset += bytes.length; }
  async add(path, bytes) {
    safePath(path); if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    if (this.paths.has(path) || this.entries.length >= 65534) throw new Error('Duplicate archive path or too many files.');
    const name = encoder.encode(path); if (name.length > 65535 || bytes.length > 0xffffffff) throw new Error('ZIP entry is too large.');
    const offset = this.offset, crc = crc32(bytes), hash = await sha256(bytes), head = header(30, 0x04034b50), v = view(head);
    v.setUint16(4, 20, true); v.setUint16(6, 0x800, true); v.setUint16(12, 33, true); // UTF-8; 1980-01-01
    v.setUint32(14, crc, true); v.setUint32(18, bytes.length, true); v.setUint32(22, bytes.length, true); v.setUint16(26, name.length, true);
    await this.chunk(head); await this.chunk(name); await this.chunk(bytes);
    this.paths.add(path); this.entries.push({ path, name, offset, crc, size: bytes.length, sha256: hash });
    return { path, size: bytes.length, sha256: hash };
  }
  async finish() {
    const start = this.offset;
    for (const entry of this.entries) {
      const head = header(46, 0x02014b50), v = view(head);
      v.setUint16(4, 20, true); v.setUint16(6, 20, true); v.setUint16(8, 0x800, true); v.setUint16(14, 33, true);
      v.setUint32(16, entry.crc, true); v.setUint32(20, entry.size, true); v.setUint32(24, entry.size, true); v.setUint16(28, entry.name.length, true); v.setUint32(42, entry.offset, true);
      await this.chunk(head); await this.chunk(entry.name);
    }
    const end = header(22, 0x06054b50), v = view(end);
    v.setUint16(8, this.entries.length, true); v.setUint16(10, this.entries.length, true); v.setUint32(12, this.offset - start, true); v.setUint32(16, start, true);
    await this.chunk(end);
  }
}
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function httpsLink(value, label) {
  try { const url = new URL(value); if (url.protocol === 'https:' && !url.username && !url.password) return `<a rel="noreferrer" href="${escape(url.href)}">${escape(label)}</a>`; } catch { /* preserve the raw URL in JSON */ }
  return '';
}
function readableIndex(workspace, manifest) {
  const people = new Map(workspace.profiles.map(p => [p.id, p]));
  const date = value => value ? escape(value) : '—';
  const sections = workspace.profiles.filter(p => p.role === 'student').map(person => {
    const reports = workspace.reports.filter(r => r.student_id === person.id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    return `<section><h2>${escape(person.full_name)} ${person.active ? '' : '(archived)'}</h2><p>@${escape(person.username)} · ${escape(person.contact_email || '')}</p><p>${escape(person.thesis_title)} · Expected defence: ${date(person.defence_date)}</p>${reports.map(report => `<article><h3>${escape(report.title)}</h3><p>${date(report.created_at)} · ${escape(report.kind)} · ${escape(report.document_type || '')}</p><p class="text">${escape(report.body)}</p>${report.file_path ? `<p><a href="files/${escape(report.file_path)}">${escape(report.file_name || 'Original PDF')}</a></p>` : ''}${report.share_url ? `<p>${httpsLink(report.share_url, 'External shared document (not copied)')}</p>` : ''}${workspace.comments.filter(c => c.report_id === report.id).map(c => `<blockquote><strong>${escape(people.get(c.author_id)?.full_name)}</strong> · ${date(c.created_at)}<p class="text">${escape(c.body)}</p></blockquote>`).join('')}${workspace.reviews.filter(r => r.report_id === report.id).map(review => `<h4>PDF feedback · revision ${escape(review.revision)}</h4><ol>${review.annotations.map(mark => `<li>Page ${escape(mark.page)} · ${escape(mark.type)}<p class="text">${escape(mark.text || '(highlight)')}</p></li>`).join('')}</ol><p>The exact highlight positions are preserved in records/thesis_pdf_reviews.json.</p>`).join('')}</article>`).join('') || '<p>No progress submissions.</p>'}<h3>Next steps</h3><ul>${workspace.tasks.filter(t => t.student_id === person.id).map(t => `<li>${escape(t.title)} · ${t.completed ? 'Completed' : 'Open'} · Due: ${date(t.due_date)}</li>`).join('')}</ul><h3>Meetings (UTC timestamps)</h3>${workspace.slots.filter(s => s.booked_by === person.id).map(s => `<article><p>${date(s.starts_at)} – ${date(s.ends_at)} · ${escape(s.location)}</p><p class="text">${escape(s.agenda)}</p><p class="text">${escape(s.meeting_notes)}</p>${httpsLink(s.teams_join_url, 'Teams meeting')}</article>`).join('')}</section>`;
  }).join('');
  return encoder.encode(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Thesis workspace backup</title><style>body{font:17px/1.6 system-ui,sans-serif;color:#182b38;max-width:1000px;margin:32px auto;padding:0 20px}section{border-top:3px solid #187a74;margin-top:40px}article{border:1px solid #bac8ce;border-radius:8px;padding:20px;margin:20px 0}a{color:#075e58}.text{white-space:pre-wrap;overflow-wrap:anywhere}blockquote{border-left:3px solid #bac8ce;padding-left:16px;margin-left:0}</style><h1>Thesis workspace backup</h1><p>Created ${escape(manifest.started_at)}. Private student records; keep this archive securely.</p><p>Extract the ZIP first, then open this index. PDFs are original uploads. PDF feedback is listed below and its full coordinates remain in JSON. External sharing links are not file copies.</p><p>${workspace.profiles.length} profiles · ${workspace.reports.length} submissions · ${workspace.reviews.length} PDF reviews · ${manifest.storage.length} stored files.</p>${sections}<h2>All meeting availability</h2><ul>${workspace.slots.filter(s => !s.booked_by).map(s => `<li>${date(s.starts_at)} – ${date(s.ends_at)} · ${escape(s.location)}</li>`).join('')}</ul><p>All database fields are in workspace.json and records/. Account passwords, active sessions, deployed secrets, and external Microsoft 365/Drive contents are excluded. This is a workspace content archive, not a complete Supabase server image.</p></html>`);
}
export async function createWorkspaceArchive(source, zip, progress = () => {}) {
  const started_at = new Date().toISOString();
  progress('Reading all workspace records and PDF inventory…');
  const snapshot = await source.snapshot(); validateWorkspace(snapshot.workspace, snapshot.files);
  const manifest = { format: 'thesis-workspace-backup', version: BACKUP_VERSION, started_at, finished_at: null,
    mode: source.mode, project: source.project || null, verification: 'ZIP is reread and checked before release; see download result or the adjacent verification report.', counts: Object.fromEntries(WORKSPACE_TABLES.map(n => [n, snapshot.workspace[n].length])),
    storage: [], entries: [], exclusions: ['Account passwords and active sessions', 'Deployed backend/Vault secrets', 'External Drive files', 'Microsoft 365 calendars, email and flow definitions'],
    consistency: 'Records and storage inventory compared before and after download; not a transaction or point-in-time database snapshot.' };
  async function add(path, bytes) { const entry = await zip.add(path, bytes); manifest.entries.push(entry); }
  await add('workspace.json', json(snapshot.workspace));
  for (const name of WORKSPACE_TABLES) await add(`records/${tableName(name)}.json`, json(snapshot.workspace[name]));
  for (let i = 0; i < snapshot.files.length; i++) {
    const file = snapshot.files[i]; progress(`Copying PDF ${i + 1} of ${snapshot.files.length}…`);
    const bytes = await source.file(file.path);
    if (file.size !== null && bytes.length !== file.size) throw new Error('A stored file is incomplete. Backup stopped.');
    for (const report of snapshot.workspace.reports.filter(r => r.file_path === file.path)) if (report.file_size !== bytes.length) throw new Error('An uploaded PDF is incomplete. Backup stopped.');
    await add(`files/${file.path}`, bytes);
    manifest.storage.push({ ...file, archive_path: `files/${file.path}`, size: bytes.length });
  }
  if (source.extras) for await (const entry of source.extras()) await add(entry.path, entry.bytes);
  progress('Checking the workspace has not changed during download…');
  assertUnchanged(snapshot, await source.snapshot());
  await add('index.html', readableIndex(snapshot.workspace, manifest));
  await add('README.txt', encoder.encode('PRIVATE WORKSPACE BACKUP\n\nExtract this ZIP and open index.html to read student progress offline.\nworkspace.json and records/ preserve all application fields and PDF annotations.\nfiles/ preserves every object in the thesis-files bucket, including unlinked objects.\nmanifest.json lists record counts, file sizes and SHA-256 checksums.\n\nThis is a content backup, not a complete Supabase disaster-recovery image.\nIt excludes account passwords, sessions, deployed secrets, external Drive files,\nand Microsoft 365 calendars/emails/flow definitions. Scheduled backups additionally\ninclude Auth account metadata, automation queue records and available local source.\nAuth metadata does NOT contain password hashes; recovered accounts need new passwords.\nA separate database dump and secret/configuration recovery kit are needed to preserve\nall authentication/database internals. Never replay automation queue jobs on recovery.\nNo restore operation is provided or performed by this backup tool.\n'));
  manifest.finished_at = new Date().toISOString();
  await zip.add('manifest.json', json(manifest)); await zip.finish();
  return manifest;
}
// Validate the bytes actually written, not only the objects used to build the archive.
export async function verifyArchive(size, read) {
  if (size < 22) throw new Error('Incomplete ZIP.');
  const tailStart = Math.max(0, size - 65557), tail = await read(tailStart, size - tailStart);
  let end = tail.length - 22;
  while (end >= 0 && view(tail).getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error('ZIP directory is missing.');
  const e = view(tail), count = e.getUint16(end + 10, true), start = e.getUint32(end + 16, true), directorySize = e.getUint32(end + 12, true);
  if (e.getUint16(end + 4, true) || e.getUint16(end + 6, true) || e.getUint16(end + 8, true) !== count || start + directorySize !== tailStart + end || end + 22 + e.getUint16(end + 20, true) !== tail.length) throw new Error('Invalid ZIP directory.');
  const directory = await read(start, directorySize), entries = new Map(); let offset = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > directory.length || view(directory).getUint32(offset, true) !== 0x02014b50) throw new Error('Corrupt ZIP entry.');
    const d = view(directory), length = d.getUint16(offset + 28, true), extra = d.getUint16(offset + 30, true), comment = d.getUint16(offset + 32, true);
    const path = safePath(decoder.decode(directory.slice(offset + 46, offset + 46 + length))), bytes = d.getUint32(offset + 24, true), localOffset = d.getUint32(offset + 42, true), crc = d.getUint32(offset + 16, true);
    if (entries.has(path) || d.getUint16(offset + 10, true) !== 0 || d.getUint32(offset + 20, true) !== bytes) throw new Error('Unexpected ZIP format.');
    const local = await read(localOffset, 30), l = view(local);
    if (l.getUint32(0, true) !== 0x04034b50 || l.getUint16(8, true) !== 0 || l.getUint32(14, true) !== crc || l.getUint32(18, true) !== bytes || l.getUint32(22, true) !== bytes) throw new Error('ZIP file header does not match.');
    const nameLength = l.getUint16(26, true), dataOffset = localOffset + 30 + nameLength + l.getUint16(28, true);
    if (dataOffset + bytes > start || decoder.decode(await read(localOffset + 30, nameLength)) !== path) throw new Error('ZIP entry bounds do not match.');
    entries.set(path, { size: bytes, offset: dataOffset, crc }); offset += 46 + length + extra + comment;
  }
  if (offset !== directory.length || !entries.has('manifest.json')) throw new Error('Invalid ZIP manifest.');
  async function bytesFor(path) { const entry = entries.get(path); if (!entry) throw new Error('Required archive entry missing.'); const bytes = await read(entry.offset, entry.size); if (bytes.length !== entry.size || crc32(bytes) !== entry.crc) throw new Error('Archive file checksum failed.'); return bytes; }
  const manifest = JSON.parse(decoder.decode(await bytesFor('manifest.json')));
  if (manifest.format !== 'thesis-workspace-backup' || manifest.version !== BACKUP_VERSION || manifest.entries.length + 1 !== entries.size) throw new Error('Unsupported or incomplete backup manifest.');
  const declared = new Set();
  for (const expected of manifest.entries) {
    if (declared.has(expected.path) || expected.path === 'manifest.json' || entries.get(expected.path)?.size !== expected.size || await sha256(await bytesFor(expected.path)) !== expected.sha256) throw new Error('Archive SHA-256 verification failed.');
    declared.add(expected.path);
  }
  const workspace = JSON.parse(decoder.decode(await bytesFor('workspace.json'))); validateWorkspace(workspace, manifest.storage);
  for (const name of WORKSPACE_TABLES) {
    if (workspace[name].length !== manifest.counts[name] || canonical(JSON.parse(decoder.decode(await bytesFor(`records/${tableName(name)}.json`)))) !== canonical(workspace[name])) throw new Error('Record counts or record contents do not match.');
  }
  const archived = [...entries.keys()].filter(path => path.startsWith('files/'));
  if (archived.length !== manifest.storage.length) throw new Error('Storage inventory is incomplete.');
  for (const file of manifest.storage) if (file.archive_path !== `files/${file.path}` || entries.get(file.archive_path)?.size !== file.size) throw new Error('Stored file missing from archive.');
  return { verified: true, counts: manifest.counts, files: manifest.storage.length, entries: entries.size, manifest };
}
