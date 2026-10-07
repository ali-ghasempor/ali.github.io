export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function httpsURL(value) {
  if (!value?.trim()) return null;
  try { const url = new URL(value.trim()); if (url.protocol !== 'https:' || url.username || url.password) throw Error(); return url.href; }
  catch { throw new Error('Please use a full HTTPS sharing link.'); }
}
export function loginEmail(username) {
  const name = username.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(name)) throw new Error('Enter your username (3–32 letters, numbers, dots, underscores or hyphens).');
  return `${name}@thesis.invalid`;
}
function accountName(value) {
  const name = value.trim();
  if (!name || name.length > 120) throw new Error('Use a name of 1–120 characters.');
  return name;
}
function passwordChange(current, password, confirmation) {
  if (!current) throw new Error('Enter your current password.');
  if (password.length < 12 || password.length > 128) throw new Error('Use a password of 12–128 characters.');
  if (password !== confirmation) throw new Error('The new passwords do not match.');
  if (password === current) throw new Error('Choose a different password from your current one.');
}
export async function validatePDF(file) {
  if (!file) return;
  if (!file.size || file.size > MAX_PDF_BYTES) throw new Error('PDFs must be no larger than 20 MB. You can use a Drive sharing link instead.');
  if (!/\.pdf$/i.test(file.name)) throw new Error('Choose a PDF file.');
  const signature = new TextDecoder().decode(await file.slice(0, 5).arrayBuffer());
  if (signature !== '%PDF-') throw new Error('This file does not appear to be a valid PDF.');
}
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const fail = error => { if (error) throw new Error(error.message || String(error)); };
const CONFIG_KEY = 'thesis.connection.v1';
export function getConnection() { try { const c = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null'); return c ? validateConnection(c.url, c.key) : null; } catch { return null; } }
export function validateConnection(url, key) {
  const parsed = new URL(url.trim());
  if (parsed.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(parsed.hostname) || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password)
    throw new Error('Enter your Supabase project URL, such as https://your-project.supabase.co.');
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key.trim())) throw new Error('Use a publishable key starting with sb_publishable_.');
  return { url: parsed.origin, key: key.trim() };
}
export function setConnection(url, key) { localStorage.setItem(CONFIG_KEY, JSON.stringify(validateConnection(url, key))); }
export function clearConnection() { localStorage.removeItem(CONFIG_KEY); }
export function createSignInLink(config, target = 'https://ali.cyberwise.ee/thesis-manager.html') {
  const link = new URL(target); link.search = ''; link.hash = new URLSearchParams(validateConnection(config.url, config.key)).toString();
  return link.href;
}

export class SupabaseStore {
  constructor(config) {
    this.mode = 'live';
    this.client = window.supabase.createClient(config.url, config.key, { auth: { storageKey: `thesis.auth.${new URL(config.url).hostname}`, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
  }
  async currentUser() {
    const { data: session } = await this.client.auth.getSession();
    if (!session.session) return null;
    const { data, error } = await this.client.auth.getUser(); fail(error);
    return this.profile(data.user.id);
  }
  async profile(id) {
    const { data, error } = await this.client.from('thesis_profiles').select('*').eq('id', id).single();
    if (error) throw new Error('Your Auth sign-in succeeded, but your workspace profile is unavailable. The supervisor should check supabase/verify-setup.sql in the SQL Editor.');
    if (!data.active) throw new Error('This account has been archived. Contact your supervisor.');
    this.user = data; return data;
  }
  async login(username, password) {
    const { data, error } = await this.client.auth.signInWithPassword({ email: loginEmail(username), password });
    if (error) throw new Error(error.code === 'email_not_confirmed' ? 'Your account email is not confirmed. Ask your supervisor to confirm the Auth user in Supabase.' : 'Real workspace sign-in failed. Check your username and Supabase account password.');
    try { return await this.profile(data.user.id); } catch (e) { await this.logout(); throw e; }
  }
  async logout() { const { error } = await this.client.auth.signOut(); fail(error); this.user = null; }
  async updateMyProfile(full_name) {
    const { error } = await this.client.rpc('thesis_update_my_profile', { new_full_name: accountName(full_name) });
    if (error?.code === 'PGRST202') throw new Error('Name changes need the account update. Ask your supervisor to run supabase/account-update.sql.');
    fail(error);
  }
  async changeMyPassword(current, password, confirmation) {
    passwordChange(current, password, confirmation);
    // A fresh password sign-in also satisfies Supabase's recent-session requirement.
    const { data, error } = await this.client.auth.signInWithPassword({ email: loginEmail(this.user.username), password: current });
    if (error?.code === 'invalid_credentials') throw new Error('Your current password is incorrect.');
    fail(error);
    if (data.user.id !== this.user.id) throw new Error('Please sign out and sign in again before changing your password.');
    const result = await this.client.auth.updateUser({ password, current_password: current }); fail(result.error);
  }
  async load() {
    const results = await Promise.all(['profiles', 'reports', 'comments', 'tasks', 'slots'].map(async name => {
      const rows = [];
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await this.client.from(`thesis_${name}`).select('*').order('id').range(offset, offset + 999);
        fail(error); rows.push(...data); if (data.length < 1000) break;
      }
      return [name, rows];
    }));
    return Object.fromEntries(results);
  }
  async account(action, values) {
    const { data, error } = await this.client.functions.invoke('thesis-accounts', { body: { action, ...values } });
    if (error) {
      let detail; try { detail = await error.context?.json(); } catch { /* preserve useful error below */ }
      throw new Error(detail?.error || 'Account management is unavailable. Deploy thesis-accounts in Supabase Edge Functions, then retry. See PRODUCTION.md, step 3.');
    }
    if (data?.error) throw new Error(data.error); return data;
  }
  async checkSetup() {
    const checks = ['profiles', 'reports', 'comments', 'tasks', 'slots'].map(name => ({
      label: `${name[0].toUpperCase()}${name.slice(1)} database`,
      run: async () => { const { error } = await this.client.from(`thesis_${name}`).select('id').limit(1); fail(error); return 'Accessible through your account permissions.'; }
    }));
    checks.push({ label: 'Private PDF storage', run: async () => {
      const { error } = await this.client.storage.from('thesis-files').list('', { limit: 1 }); fail(error); return 'The private thesis-files bucket is accessible.';
    } });
    checks.push({ label: 'Student account management', run: async () => {
      const result = await this.account('status', {});
      if (!result?.ok || result.version !== '2026-10-07') throw new Error('Deploy the current thesis-accounts/index.ts (release 2026-10-07).');
      return `Function deployed: ${result.version}.`;
    } });
    return Promise.all(checks.map(async check => { try { return { label: check.label, ok: true, detail: await check.run() }; }
      catch (error) { return { label: check.label, ok: false, detail: error.message }; } }));
  }
  async submitReport(values, file) {
    await validatePDF(file);
    const id = uuid(); const path = `${this.user.id}/${id}.pdf`;
    const row = { ...values, id, student_id: this.user.id, share_url: httpsURL(values.share_url),
      file_path: null, file_name: null, file_size: null };
    if (file) {
      const { error } = await this.client.storage.from('thesis-files').upload(path, file, { contentType: 'application/pdf', upsert: false });
      if (error) throw new Error(`PDF upload failed: ${error.message}. Your notes are still in this form; remove the file and add a sharing link instead.`);
      Object.assign(row, { file_path: path, file_name: file.name, file_size: file.size });
    }
    const { error } = await this.client.from('thesis_reports').insert(row);
    if (error && file) await this.client.storage.from('thesis-files').remove([path]);
    fail(error);
  }
  async fileURL(report) {
    const { data, error } = await this.client.storage.from('thesis-files').createSignedUrl(report.file_path, 300); fail(error); return data.signedUrl;
  }
  async comment(report_id, body) { const { error } = await this.client.from('thesis_comments').insert({ report_id, body, author_id: this.user.id }); fail(error); }
  async task(student_id, title, due_date) { const { error } = await this.client.from('thesis_tasks').insert({ student_id, title, due_date: due_date || null, created_by: this.user.id }); fail(error); }
  async completeTask(task_id, done) { const { error } = await this.client.rpc('thesis_complete_task', { task_id, done }); fail(error); }
  async createSlots(slots) { const { error } = await this.client.from('thesis_slots').insert(slots); fail(error); }
  async book(slot_id, booking_agenda) { const { error } = await this.client.rpc('thesis_book_meeting', { slot_id, booking_agenda }); fail(error); }
  async cancel(slot_id) { const { error } = await this.client.rpc('thesis_cancel_meeting', { slot_id }); fail(error); }
  async meetingNotes(slot_id, notes) { const { error } = await this.client.rpc('thesis_save_meeting_notes', { slot_id, notes }); fail(error); }
  async deleteSlot(id) { const { error } = await this.client.from('thesis_slots').delete().eq('id', id); fail(error); }
  dispose() { this.client.auth.stopAutoRefresh(); }
}

const DEMO_KEY = 'thesis.demo.v1';
const DEMO_SESSION = 'thesis.demo.session.v1';
// This demo is intentionally browser-local and is never a production authentication system.
const sampleProfiles = [
  { id: 'demo-supervisor', username: 'ali', full_name: 'Ali Ghasempour', role: 'supervisor', active: true, thesis_title: '' },
  { id: 'demo-alex', username: 'alex', full_name: 'Alex Morgan', role: 'student', active: true, thesis_title: 'Evaluating Detection Coverage in Cloud-Native Systems', defence_date: '2027-06-15' },
  { id: 'demo-sam', username: 'sam', full_name: 'Sam Rivera', role: 'student', active: true, thesis_title: 'Secure Logging for Container Platforms', defence_date: '2027-01-15' },
  { id: 'demo-robin', username: 'robin', full_name: 'Robin Chen', role: 'student', active: true, thesis_title: 'Practical Analysis of Web Application Security', defence_date: '2027-06-15' }
];
async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256);
  return Array.from(new Uint8Array(bits), b => b.toString(16).padStart(2, '0')).join('');
}
function filesDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('thesis-demo-files', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
}
async function demoFile(operation, path, file) {
  const db = await filesDB();
  try { return await new Promise((resolve, reject) => {
    const tx = db.transaction('files', operation === 'get' ? 'readonly' : 'readwrite');
    const req = operation === 'get' ? tx.objectStore('files').get(path) : tx.objectStore('files').put(file, path);
    tx.oncomplete = () => resolve(req.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  }); } finally { db.close(); }
}
export class DemoStore {
  constructor() { this.mode = 'demo'; }
  async init() {
    if (localStorage.getItem(DEMO_KEY)) return;
    const profiles = [];
    for (const p of sampleProfiles) { const salt = uuid(); profiles.push({ ...p, salt, password_hash: await passwordHash('demo-thesis-2026', salt), created_at: now() }); }
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(14, 0, 0, 0);
    const start = tomorrow.toISOString(); const end = new Date(+tomorrow + 30 * 60000).toISOString();
    this.write({ profiles, reports: [{ id: 'demo-report', student_id: 'demo-alex', title: 'Literature review and test plan', kind: 'progress',
      body: 'I compared the main approaches to detection coverage and drafted the laboratory test plan. Next I will define the baseline and measurement criteria.',
      share_url: null, file_path: null, created_at: now() }], comments: [],
      tasks: [{ id: 'demo-task', student_id: 'demo-alex', created_by: 'demo-supervisor', title: 'Define the baseline and evaluation metrics', due_date: null, completed: false, created_at: now() }],
      slots: [{ id: 'demo-slot', starts_at: start, ends_at: end, location: 'MS Teams', booked_by: null, agenda: '', meeting_notes: '' }] });
  }
  read() { return JSON.parse(localStorage.getItem(DEMO_KEY)); }
  write(data) { localStorage.setItem(DEMO_KEY, JSON.stringify(data)); }
  requireSupervisor() { if (this.user?.role !== 'supervisor') throw new Error('Supervisor account required.'); }
  async currentUser() { await this.init(); this.user = this.read().profiles.find(p => p.id === sessionStorage.getItem(DEMO_SESSION) && p.active); return this.user || null; }
  async login(username, password) {
    await this.init(); const p = this.read().profiles.find(p => p.username === username.trim().toLowerCase() && p.active);
    if (!p || await passwordHash(password, p.salt) !== p.password_hash) throw new Error('Check your demo username and password.');
    sessionStorage.setItem(DEMO_SESSION, p.id); this.user = p; return p;
  }
  async logout() { sessionStorage.removeItem(DEMO_SESSION); this.user = null; }
  async updateMyProfile(full_name) {
    const d = this.read(), p = d.profiles.find(p => p.id === this.user?.id && p.active);
    if (!p) throw new Error('An active account is required.');
    p.full_name = accountName(full_name); this.write(d); this.user = p;
  }
  async changeMyPassword(current, password, confirmation) {
    passwordChange(current, password, confirmation);
    const d = this.read(), p = d.profiles.find(p => p.id === this.user?.id && p.active);
    if (!p) throw new Error('An active account is required.');
    if (await passwordHash(current, p.salt) !== p.password_hash) throw new Error('Your current password is incorrect.');
    p.salt = uuid(); p.password_hash = await passwordHash(password, p.salt); this.write(d); this.user = p;
  }
  async load() {
    const data = this.read(); if (this.user.role === 'supervisor') return data;
    const reports = data.reports.filter(r => r.student_id === this.user.id);
    return { profiles: data.profiles.filter(p => p.id === this.user.id), reports,
      comments: data.comments.filter(c => reports.some(r => r.id === c.report_id)),
      tasks: data.tasks.filter(t => t.student_id === this.user.id),
      slots: data.slots.filter(s => !s.booked_by || s.booked_by === this.user.id) };
  }
  async account(action, v) {
    this.requireSupervisor(); const d = this.read();
    if (action === 'create') {
      loginEmail(v.username);
      if (d.profiles.some(p => p.username === v.username)) throw new Error('This username is already taken.');
      if (v.password.length < 12 || v.password.length > 128) throw new Error('Use a password of 12–128 characters.');
      const salt = uuid(); d.profiles.push({ id: uuid(), ...v, role: 'student', active: true, salt,
        password_hash: await passwordHash(v.password, salt), created_at: now(), password: undefined });
    } else {
      const p = d.profiles.find(p => p.id === v.student_id && p.role === 'student'); if (!p) throw new Error('Student not found.');
      if (action === 'password') { if (v.password.length < 12) throw new Error('Use at least 12 characters.'); p.password_hash = await passwordHash(v.password, p.salt); }
      else { p.active = action === 'restore'; if (!p.active) d.slots.filter(s => s.booked_by === p.id && new Date(s.starts_at) > new Date()).forEach(s => Object.assign(s, { booked_by: null, agenda: '', meeting_notes: '' })); }
    }
    this.write(d);
  }
  async submitReport(v, file) {
    if (this.user.role !== 'student') throw new Error('Student account required.'); await validatePDF(file);
    const d = this.read(); const id = uuid(); const path = `${this.user.id}/${id}.pdf`;
    if (file) await demoFile('put', path, file);
    d.reports.push({ ...v, id, student_id: this.user.id, share_url: httpsURL(v.share_url), file_path: file ? path : null,
      file_name: file?.name || null, file_size: file?.size || null, created_at: now() }); this.write(d);
  }
  async fileURL(report) { const file = await demoFile('get', report.file_path); if (!file) throw new Error('This demo file is not in this browser.'); return URL.createObjectURL(file); }
  async comment(report_id, body) { this.requireSupervisor(); const d = this.read(); d.comments.push({ id: uuid(), report_id, body, author_id: this.user.id, created_at: now() }); this.write(d); }
  async task(student_id, title, due_date) { this.requireSupervisor(); const d = this.read(); d.tasks.push({ id: uuid(), student_id, title, due_date: due_date || null, created_by: this.user.id, completed: false, created_at: now() }); this.write(d); }
  async completeTask(id, completed) { const d = this.read(); const task = d.tasks.find(t => t.id === id && (t.student_id === this.user.id || this.user.role === 'supervisor')); if (!task) throw new Error('Task not found.'); task.completed = completed; this.write(d); }
  async createSlots(slots) {
    this.requireSupervisor(); const d = this.read();
    if (slots.some(n => d.slots.some(s => n.starts_at < s.ends_at && n.ends_at > s.starts_at))) throw new Error('These times overlap an existing slot.');
    d.slots.push(...slots.map(s => ({ ...s, id: uuid(), booked_by: null, agenda: '', meeting_notes: '' }))); this.write(d);
  }
  async book(id, agenda) { const d = this.read(); const slot = d.slots.find(s => s.id === id); if (this.user.role !== 'student' || !slot || slot.booked_by || new Date(slot.starts_at) <= new Date()) throw new Error('This slot is no longer available.'); Object.assign(slot, { booked_by: this.user.id, agenda }); this.write(d); }
  async cancel(id) { const d = this.read(); const s = d.slots.find(s => s.id === id); if (!s || !s.booked_by || (this.user.role !== 'supervisor' && (s.booked_by !== this.user.id || new Date(s.starts_at) <= new Date()))) throw new Error('This meeting cannot be cancelled.'); Object.assign(s, { booked_by: null, agenda: '', meeting_notes: '' }); this.write(d); }
  async meetingNotes(id, notes) { this.requireSupervisor(); const d = this.read(); const s = d.slots.find(s => s.id === id); s.meeting_notes = notes; this.write(d); }
  async deleteSlot(id) { this.requireSupervisor(); const d = this.read(); const s = d.slots.find(s => s.id === id); if (s?.booked_by) throw new Error('Cancel the booking first.'); d.slots = d.slots.filter(s => s.id !== id); this.write(d); }
  dispose() {}
}
