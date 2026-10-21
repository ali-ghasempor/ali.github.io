import { DemoStore, SupabaseStore, escapeHTML as e, getConnection, setConnection, clearConnection, validatePDF, validateAsice, httpsURL } from './thesis-data.js?v=2026-10-21-signing-changes';

const app = document.querySelector('#app');
const modal = document.querySelector('#modal');
const TIMEZONE = 'Europe/Tallinn';
const LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
// Local tools require an explicit URL; normal sign-in never exposes them.
const DEMO = LOCAL && new URLSearchParams(location.search).get('demo') === '1';
const SETUP = LOCAL && new URLSearchParams(location.search).get('setup') === '1';
let store, user, toastTimer, loading = false;
let data = { profiles: [], reports: [], comments: [], tasks: [], slots: [], notes: [], signed: [] };
let view = 'overview', studentFilter = '', showArchived = false, showPastMeetings = false;
let studentImport = null, pdfSession = null, backupRunning = false;
const uploadTypes = { notes: 'Research notes', data: 'Data', presentation: 'Presentation', findings: 'Findings and graphs', other: 'Other' };
const dateKey = date => new Intl.DateTimeFormat('sv-SE', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(date));
const time = date => new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' }).format(new Date(date));
const dateText = date => new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(date.length === 10 ? `${date}T12:00:00Z` : date));
const defenceText = date => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(`${date.slice(0, 7)}-01T12:00:00Z`));
// The existing date column stores the first day as a month anchor, not a scheduled defence day.
function defenceDate(month) {
  if (!month) return null;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || Number(month.slice(0, 4)) < 1900) throw new Error('Choose a valid expected defence month.');
  return `${month}-01`;
}
let selectedDay = dateKey(new Date()), month = selectedDay.slice(0, 7);
const initials = name => name.split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase();
const studentName = id => data.profiles.find(p => p.id === id)?.full_name || 'Student';
const isSupervisor = () => user?.role === 'supervisor';
const canConfigure = () => LOCAL && (isSupervisor() || (!user && SETUP));
const sortedReports = () => [...data.reports].sort((a, b) => b.created_at.localeCompare(a.created_at));
const futureMeetings = () => data.slots.filter(s => s.booked_by && new Date(s.starts_at) > new Date()).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
const upcomingMeetings = () => data.slots.filter(s => s.booked_by && new Date(s.ends_at) > new Date()).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
const pastMeetings = () => data.slots.filter(s => s.booked_by && new Date(s.ends_at) <= new Date()).sort((a, b) => b.starts_at.localeCompare(a.starts_at));
const openTasks = () => data.tasks.filter(t => !t.completed);
const pdfFeedback = id => (data.reviews || []).find(r => r.report_id === id);
const isSigned = r => r.document_type === 'signed';
const isPdf = r => Boolean(r.file_path) && !isSigned(r);
const docLabel = r => r.kind === 'thesis' ? 'Thesis draft' : isSigned(r) ? 'Signed document (.asice)' : 'Progress update · ' + (uploadTypes[r.document_type] || 'Other');
const signedVersions = id => (data.signed || []).filter(v => v.report_id === id).sort((a, b) => a.created_at.localeCompare(b.created_at));
// Who uploaded a file: students cannot read the supervisor's profile, so the label comes from the document itself.
const uploader = (id, report) => id === report.student_id ? (id === user.id ? 'You' : studentName(id)) : (id === user.id ? 'You' : 'Supervisor');
const ownTask = t => t.created_by === t.student_id;
// A signed document waits for the supervisor while the student signed last, and counts as answered once the supervisor did.
const latestSigner = r => signedVersions(r.id).at(-1)?.uploaded_by || r.created_by || r.student_id;
// The supervisor declined the student's latest version and asked for changes; a newer student upload re-opens it.
const changesRequested = r => r.document_type === 'signed' && Boolean(r.signing_rejected_at) && latestSigner(r) === r.student_id &&
  Date.parse(r.signing_rejected_at) >= Date.parse(signedVersions(r.id).at(-1)?.created_at || r.created_at);
const hasFeedback = r => r.document_type === 'signed' ? latestSigner(r) !== r.student_id || changesRequested(r) : data.comments.some(c => c.report_id === r.id) || Boolean(pdfFeedback(r.id));
const icons = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  students: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M15 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
  meetings: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18m-13 5h2m4 0h2"/>',
  progress: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5"/>',
  settings: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5m-5-3a8 8 0 0 1 13.6-5.6L20 6M4 18l2.4 2.6A8 8 0 0 0 20 15"/>'
};
// Intrinsic dimensions also keep icons small if an older stylesheet is cached.
const icon = key => `<svg class="ui-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${icons[key]}</svg>`;
const safeShareURL = value => { try { return httpsURL(value); } catch { return null; } };
const empty = (title, text) => `<div class="empty"><span class="empty-icon">◇</span><h3>${e(title)}</h3><p>${e(text)}</p></div>`;
const badge = (text, type = '') => `<span class="badge ${type}">${e(text)}</span>`;
// Browser-side errors go to the monitoring logs (no document text), at most 20 per page load and once per minute each.
const reported = new Map(); let lastAction = 'none';
function reportError(kind, message) {
  try {
    const key = `${kind}|${message}`;
    if (!store || reported.size >= 20 || Date.now() - (reported.get(key) || 0) < 60000) return;
    reported.set(key, Date.now());
    store.reportError({ kind, message: String(message || '').slice(0, 2000), action: lastAction,
      version: document.querySelector('meta[name="thesis-release"]')?.content || 'unknown' });
  } catch { /* Reporting must never cause a new error. */ }
}
window.addEventListener('error', event => reportError('exception', event.message));
window.addEventListener('unhandledrejection', event => reportError('rejection', event.reason?.message || String(event.reason)));
// Remembers which control the user last used, so a report says where an error came from.
document.addEventListener('click', event => {
  const control = event.target.closest?.('[data-action],[data-pdf],[data-diff],[data-form]');
  const name = control?.dataset.action || control?.dataset.pdf && 'pdf-' + control.dataset.pdf || control?.dataset.diff && 'diff-' + control.dataset.diff || control?.dataset.form && 'form-' + control.dataset.form;
  if (name) lastAction = String(name).toLowerCase().replace(/[^a-z0-9:_-]/g, '').slice(0, 40) || lastAction;
}, true);
function toast(message, error = false) {
  if (error) reportError('toast', message);
  const el = document.querySelector('#toast'); el.textContent = message; el.className = `toast ${error ? 'error' : ''}`; el.hidden = false;
  // An open dialog sits in the browser's top layer; reopening the popover puts the message above it.
  if (el.showPopover) { if (el.matches(':popover-open')) el.hidePopover(); el.showPopover(); }
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { if (el.hidePopover && el.matches(':popover-open')) el.hidePopover(); el.hidden = true; }, error ? 12000 : 4500);
}
// What the student receives after new feedback (see feedback-notification-update.sql).
function feedbackNotice(reportId) {
  if (store.mode === 'demo') return 'Demo only; no e-mail is sent.';
  const report = data.reports.find(r => r.id === reportId), student = data.profiles.find(p => p.id === report?.student_id);
  return student?.contact_email ? 'The student gets an e-mail about it in a few minutes.' : 'The student has no e-mail address in Account, so they will see it in the workspace.';
}
function dialog(title, html, wide = false) {
  modal.className = wide ? 'wide' : ''; modal.innerHTML = `<div class="modal-head"><h2 id="modal-title">${e(title)}</h2><button class="icon-button" data-action="close" aria-label="Close dialog">×</button></div>${html}`;
  modal.showModal();
}
function closeDialog() { if (backupRunning || (pdfSession && !pdfSession.canClose())) return false; pdfSession?.dispose(); pdfSession = null; modal.close(); modal.innerHTML = ''; studentImport = null; return true; }
function field(label, html, extra = '') { return `<label class="field ${extra}"><span>${e(label)}</span>${html}</label>`; }
function actions(label) { return `<div class="form-actions"><button type="button" class="secondary" data-action="close">Cancel</button><button class="primary" type="submit">${e(label)}</button></div>`; }
async function busy(button, fn) {
  if (loading) return; loading = true;
  const originalChildren = button ? [...button.childNodes] : [], wasDisabled = button?.disabled;
  if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); button.textContent = 'Working…'; }
  try { await fn(); } catch (err) { toast(err.message || 'Something went wrong. Please try again.', true); }
  finally { loading = false; if (button?.isConnected) { button.disabled = wasDisabled; button.removeAttribute('aria-busy'); button.replaceChildren(...originalChildren); } }
}
async function refresh() {
  data = await store.load();
  const profile = data.profiles.find(p => p.id === user.id && p.active);
  if (!profile) { await store.logout(); user = null; render(); throw new Error('Your account no longer has access.'); }
  user = profile;
  render();
}
function renderLogin() {
  app.innerHTML = `<main class="login-layout"><div class="login-card">
    <form data-form="login" aria-label="Sign in">
      ${field('Username', '<input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="32">')}
      ${field('Password', '<input name="password" type="password" autocomplete="current-password" required>')}
      <button class="primary full" type="submit" ${!store ? 'disabled' : ''}>Sign in</button>
    </form>
    <p class="login-help">Forgot your password? Ask your supervisor for a reset.</p>
    <p class="login-guide"><a href="student-guide.html">Usage guide</a></p>
  </div></main>`;
}
function render() {
  if (!user) return renderLogin();
  const supervisor = isSupervisor();
  const nav = supervisor ? [['overview','Overview'],['students','Students'],['meetings','Meetings'],['progress','Progress'],['settings','Settings']] : [['overview','Overview'],['progress','Progress'],['meetings','Meetings'],['settings','Account']];
  const currentLabel = nav.find(([key])=>key===view)?.[1];
  const title = view==='settings' ? (supervisor?'Workspace settings':'Your account') : currentLabel;
  const pageActions = view==='students'?'<button class="secondary" data-action="import-students">Import students</button><button class="primary" data-action="add-student">+ Add student</button>':view==='progress'&&!supervisor?'<button class="primary" data-action="new-report">+ Share progress</button>':view==='meetings'&&supervisor?'<button class="primary" data-action="availability">+ Add availability</button>':'';
  app.innerHTML = `<div class="workspace"><aside class="sidebar"><a class="brand" href="index.html">Thesis workspace</a>
    <div class="sidebar-label">${supervisor ? 'SUPERVISION' : 'MY THESIS'}</div><nav class="${supervisor?'nav-supervisor':'nav-student'}" aria-label="Workspace">${nav.map(([key,label]) => `<button class="nav-item ${view===key?'active':''}" data-action="view" data-view="${key}" ${view===key?'aria-current="page"':''}>${icon(key)}<span class="nav-label">${label}</span>${key==='progress' && supervisor && data.reports.some(r=>!r.dismissed_at&&!hasFeedback(r)) ? '<i class="nav-dot" aria-hidden="true"></i>' : ''}</button>`).join('')}</nav>
    <div class="sidebar-bottom"><a href="index.html">← Personal website</a><div class="user-card"><span class="avatar">${e(initials(user.full_name))}</span><div><strong>${e(user.full_name)}</strong><small>${supervisor?'Supervisor':'Student'}</small></div><button class="icon-button" data-action="logout" aria-label="Sign out" title="Sign out">${icon('logout')}</button></div></div></aside>
    <main class="main"><header class="topbar"><strong>${e(currentLabel)}</strong><div>${badge(store.mode==='demo'?'Local demo':'Signed in',store.mode==='demo'?'amber':'green')}<button class="icon-button" data-action="refresh" aria-label="Refresh workspace">${icon('refresh')}</button></div></header>
    ${store.mode==='demo'?'<div class="demo-banner">LOCAL DEMO · Fictional sample records, stored only in this browser.</div>':''}
    <div class="page"><h1 class="sr-only page-title" tabindex="-1">${e(title)}</h1>${pageActions?`<div class="page-actions">${pageActions}</div>`:''}
    ${view==='overview'?overview():view==='students'?students():view==='progress'?progress():view==='meetings'?meetings():settings()}</div></main></div>`;
}
function metric(label,value,tone='') { return `<div class="metric ${tone}"><span>${label}</span><strong>${value}</strong></div>`; }
function overview() {
  const supervisor = isSupervisor();
  const upcoming = upcomingMeetings(); const reports = sortedReports();
  const latest = supervisor ? reports.filter(r=>!r.dismissed_at) : reports;
  return `<div class="metrics">${metric(supervisor?'Active students':'Progress updates',supervisor?data.profiles.filter(p=>p.role==='student'&&p.active).length:reports.length)}${metric('Upcoming meetings',upcoming.length)}${metric(supervisor?'Awaiting feedback':'Open next steps',supervisor?reports.filter(r=>!r.dismissed_at&&!hasFeedback(r)).length:openTasks().length,'accent')}${metric('Shared documents',reports.filter(r=>r.file_path||r.share_url).length)}</div>
    ${!supervisor?`<section class="thesis-card"><div><span class="eyebrow">YOUR THESIS</span><h2>${e(user.thesis_title || 'Your thesis title will appear here')}</h2><p>${user.defence_date?'Expected defence: '+e(defenceText(user.defence_date)):'Defence month to be agreed with your supervisor'}</p></div><button class="primary" data-action="new-report">Share progress →</button></section>`:''}
    <div class="overview-grid"><section class="panel"><div class="panel-heading"><h2>Latest progress</h2><div class="row">${supervisor&&latest.length?'<button class="text-button" data-action="dismiss-all" title="Keep the progress history and clear these updates from the overview">Dismiss all</button>':''}<button class="text-button" data-action="view" data-view="progress">View all →</button></div></div>${latest.length?latest.slice(0,4).map(r=>supervisor?`<div class="overview-report">${reportCard(r)}<button class="text-button" data-action="dismiss-report" data-id="${e(r.id)}" aria-label="Dismiss ${e(r.title)} from overview">Dismiss from overview</button></div>`:reportCard(r)).join(''):empty('All caught up',supervisor?'New progress updates will appear here. Dismissed updates stay in Progress & files.':'Progress updates will appear here when you share your work.')}</section>
    <div><section class="panel"><div class="panel-heading"><h2>Next meetings</h2><button class="text-button" data-action="view" data-view="meetings">Calendar →</button></div>${upcoming.length?upcoming.map(meetingCard).join(''):empty('Time to connect','Choose a meeting slot from the calendar.')}</section><section class="panel"><div class="panel-heading"><h2>Next steps</h2>${!supervisor?'<button class="text-button" data-action="new-task">+ Add</button>':''}</div>${taskList(openTasks().slice(0,4))}</section></div></div>`;
}
function reportCard(r) {
  return `<button class="report-card" data-action="report" data-id="${e(r.id)}"><span class="avatar soft">${e(initials(studentName(r.student_id)))}</span><div class="grow"><div class="row"><strong>${e(r.title)}</strong>${badge(isSupervisor()&&r.dismissed_at?'Dismissed from overview':isSigned(r)?(changesRequested(r)?'Changes requested':hasFeedback(r)?'Signed by supervisor':'Awaiting supervisor signature'):hasFeedback(r)?'Feedback added':'Awaiting feedback',(r.dismissed_at||changesRequested(r))&&isSupervisor()?'':changesRequested(r)?'amber':hasFeedback(r)?'green':'amber')}</div><p>${isSupervisor()?e(studentName(r.student_id))+' · ':''}${e(dateText(r.created_at))} · ${e(docLabel(r))}</p><span class="excerpt">${e(r.body.slice(0,130))}${r.body.length>130?'…':''}</span><div class="file-hint">${isSigned(r)?'✎ '+e(r.file_name)+(signedVersions(r.id).length?` · ${signedVersions(r.id).length+1} versions`:''):r.file_path?'▧ '+e(r.file_name):r.share_url?'↗ Shared document':'Notes only'}</div></div><span class="arrow">→</span></button>`;
}
function taskList(tasks) {
  if (!tasks.length) return empty('Nothing outstanding',isSupervisor()?'New next steps will appear here.':'Add your own next step, or your supervisor will assign one.');
  // Students may edit the next steps they added themselves; steps from the supervisor can only be ticked off.
  return `<div class="tasks">${tasks.map(t => `<div class="task-row"><label class="task"><input type="checkbox" data-task="${e(t.id)}" ${t.completed?'checked':''}><span><strong class="${t.completed?'done':''}">${e(t.title)}</strong><small>${isSupervisor()?e(studentName(t.student_id))+' · ':''}${t.due_date?'Due '+e(dateText(t.due_date)):'No deadline set'}${ownTask(t)?(isSupervisor()?' · Added by student':' · Added by you'):''}</small></span></label>${!isSupervisor()&&ownTask(t)&&t.student_id===user.id?`<button class="text-button" data-action="edit-task" data-id="${e(t.id)}" aria-label="Edit next step: ${e(t.title)}">Edit</button>`:''}</div>`).join('')}</div>`;
}
function notesPanel() {
  const notes=[...(data.notes||[])].sort((a,b)=>b.updated_at.localeCompare(a.updated_at));
  return `<section class="panel"><div class="panel-heading"><h2>My notes</h2><button class="text-button" data-action="new-note">+ New note</button></div>${notes.length?`<div class="notes">${notes.map(n=>`<button class="note-card" data-action="note" data-id="${e(n.id)}"><div class="row"><strong>${e(n.title||'Untitled note')}</strong>${badge(n.shared?'Shared with supervisor':'Private',n.shared?'green':'')}</div><span class="excerpt">${e(n.body.slice(0,140))}${n.body.length>140?'…':''}</span><small class="muted">Updated ${e(dateText(n.updated_at))}</small></button>`).join('')}</div>`:empty('No notes yet','Keep ideas, questions and plans here. Notes are private unless you share them with your supervisor.')}</section>`;
}
function students() {
  return `<section class="panel"><div class="toolbar"><input id="student-search" type="search" aria-label="Search students" placeholder="Search names or thesis titles…" value="${e(studentFilter)}"><label class="check"><input type="checkbox" id="show-archived" ${showArchived?'checked':''}> Include archived</label></div><div id="student-results">${studentResults()}</div></section>`;
}
function studentResults() {
  const list = data.profiles.filter(p=>p.role==='student'&&(showArchived||p.active)&&`${p.full_name} ${p.username} ${p.thesis_title}`.toLowerCase().includes(studentFilter.toLowerCase()));
  return `<div class="table-wrap"><table class="student-table"><caption class="sr-only">Student accounts</caption><thead><tr><th scope="col">Student</th><th scope="col">Thesis</th><th scope="col">Expected defence</th><th scope="col">Latest progress</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${list.map(p=>{const latest=sortedReports().find(r=>r.student_id===p.id); return `<tr><td><div class="person"><span class="avatar soft">${e(initials(p.full_name))}</span><div><strong>${e(p.full_name)}</strong><small>@${e(p.username)} ${!p.active?'· Archived':''}</small></div></div></td><td class="title-cell" data-label="Thesis">${e(p.thesis_title||'Title to be agreed')}</td><td data-label="Expected defence">${p.defence_date?e(defenceText(p.defence_date)):'—'}</td><td data-label="Latest progress">${latest?e(dateText(latest.created_at)):'No updates yet'}</td><td><button class="secondary small-button" data-action="student" data-id="${e(p.id)}" aria-label="Open ${e(p.full_name)}">Open →</button></td></tr>`;}).join('')}</tbody></table></div>${list.length?'':empty('No students found','Add a student or change your search.')}`;
}
function progress() { const reports=sortedReports(); return `<div class="progress-layout"><section class="panel"><div class="panel-heading"><h2>${isSupervisor()?'Student submissions':'Your submissions'}</h2><span class="muted small">${reports.length} updates</span></div>${reports.length?reports.map(reportCard).join(''):empty('Start with a short update','Share what you have done, what comes next, and where you need help.')}</section>${!isSupervisor()?`<div><section class="panel"><div class="panel-heading"><h2>Your next steps</h2><button class="text-button" data-action="new-task">+ Add next step</button></div>${taskList([...data.tasks].sort((a,b)=>Number(a.completed)-Number(b.completed)))}</section>${notesPanel()}</div>`:''}</div>`; }
function meetingCard(s) {
  return `<button class="meeting-card" data-action="meeting" data-id="${e(s.id)}"><div class="date-tile"><strong>${new Date(s.starts_at).toLocaleDateString('en-GB',{timeZone:TIMEZONE,day:'numeric'})}</strong><span>${new Date(s.starts_at).toLocaleDateString('en-GB',{timeZone:TIMEZONE,month:'short'})}</span></div><div class="grow"><strong>${isSupervisor()?e(studentName(s.booked_by)):'Supervision meeting'}</strong><small>${e(time(s.starts_at))}–${e(time(s.ends_at))} · ${e(s.location)}</small>${s.meeting_notes?badge('Meeting notes added','green'):''}</div><span class="arrow">→</span></button>`;
}
function calendar() {
  const [y,m]=month.split('-').map(Number); const first=new Date(Date.UTC(y,m-1,1));
  const offset=(first.getUTCDay()+6)%7; const start=new Date(Date.UTC(y,m-1,1-offset));
  const cells=Array.from({length:42},(_,i)=>{const day=new Date(+start+i*86400000).toISOString().slice(0,10); const slots=data.slots.filter(s=>dateKey(s.starts_at)===day); return `<button class="calendar-day ${day.slice(0,7)!==month?'outside':''} ${day===selectedDay?'selected':''} ${day===dateKey(new Date())?'today':''}" data-action="day" data-day="${day}" aria-label="${e(dateText(day))}${slots.length?', '+slots.length+' slots':''}" aria-pressed="${day===selectedDay}"><span>${Number(day.slice(-2))}</span>${slots.length?'<i></i>':''}</button>`;});
  return `<div class="calendar"><div class="calendar-heading"><button class="icon-button" data-action="month" data-offset="-1" aria-label="Previous month">‹</button><h2>${new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',month:'long',year:'numeric'}).format(first)}</h2><button class="icon-button" data-action="month" data-offset="1" aria-label="Next month">›</button></div><div class="calendar-grid">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d=>`<span class="weekday">${d}</span>`).join('')}${cells.join('')}</div><p class="small muted">● Meeting slots · All times in Europe/Tallinn</p></div>`;
}
function meetings() {
  const slots=data.slots.filter(s=>dateKey(s.starts_at)===selectedDay).sort((a,b)=>a.starts_at.localeCompare(b.starts_at));
  // Students hold one upcoming meeting at a time; the database enforces the same rule.
  const booked=!isSupervisor()&&futureMeetings().length>0;
  return `<div class="calendar-layout"><section class="panel">${calendar()}</section><section class="panel"><div class="panel-heading"><div><h2>${e(dateText(selectedDay))}</h2><p class="small muted">${isSupervisor()?'Your availability and bookings':booked?'You can book again after your upcoming meeting, or cancel it first.':'Choose an available time to meet'}</p></div></div><div class="slot-list">${slots.length?slots.map(s=>`<div class="slot"><div><strong>${e(time(s.starts_at))}–${e(time(s.ends_at))}</strong><small>${e(s.location)}${s.booked_by?' · '+(isSupervisor()?e(studentName(s.booked_by)):'Your booking'):''}</small></div>${s.booked_by?`<button class="secondary small-button" data-action="meeting" data-id="${e(s.id)}">Details</button>`:new Date(s.starts_at)<=new Date()?badge('Past slot'):isSupervisor()?`<div class="row">${badge('Available','green')}<button class="icon-button" data-action="delete-slot" data-id="${e(s.id)}" aria-label="Remove ${e(time(s.starts_at))} slot">×</button></div>`:booked?badge('Available'):`<button class="primary small-button" data-action="book" data-id="${e(s.id)}">Book time</button>`}</div>`).join(''):empty('No slots on this date',isSupervisor()?'Add availability for this day.':'Try another date or ask your supervisor for availability.')}</div></section></div><section class="panel"><div class="panel-heading"><h2>${isSupervisor()?'Upcoming meetings':'Your upcoming meetings'}</h2>${pastMeetings().length?`<button class="text-button" data-action="toggle-past-meetings" aria-expanded="${showPastMeetings}">${showPastMeetings?'Hide past meetings':`Show past meetings (${pastMeetings().length})`}</button>`:''}</div>${upcomingMeetings().length?upcomingMeetings().map(meetingCard).join(''):empty('No upcoming meetings',isSupervisor()?'Booked meetings will appear here.':'Book a time from the calendar above.')}</section>${showPastMeetings&&pastMeetings().length?`<section class="panel past-meetings"><div class="panel-heading"><h2>Past meetings</h2><span class="muted small">${pastMeetings().length} meetings · newest first</span></div>${pastMeetings().map(meetingCard).join('')}</section>`:''}`;
}
function settings() {
  const account = `<section class="panel padded"><h2>Profile</h2><dl><dt>Username</dt><dd>${e(user.username)}</dd><dt>Role</dt><dd>${isSupervisor()?'Supervisor':'Student'}</dd></dl><form data-form="my-profile">${field('Full name',`<input name="full_name" value="${e(user.full_name)}" required maxlength="120" autocomplete="name">`)}<button class="primary" type="submit">Save name</button></form><p class="small muted">${isSupervisor()?'Student accounts are managed from the Students page.':'Contact your supervisor to change your username.'}</p></section>
    <section class="panel padded"><h2>Change password</h2><p>Choose a password only you know.</p><form data-form="my-password">${field('Current password','<input name="current_password" type="password" required autocomplete="current-password">')}${field('New password','<input name="new_password" type="password" required minlength="12" maxlength="128" autocomplete="new-password"><small>12–128 characters. Use a unique password.</small>')}${field('Confirm new password','<input name="confirm_password" type="password" required minlength="12" maxlength="128" autocomplete="new-password">')}<button class="primary" type="submit">Change password</button></form><p class="small muted">${isSupervisor()?'If you forget your password, recover your account through the Supabase dashboard.':'Forgot your current password? Ask your supervisor to reset it, then sign in and choose a new one here.'}</p></section>`;
  const studentAccount = `<section class="panel padded"><h2>Your thesis</h2><form data-form="my-thesis">${field('Thesis title',`<textarea name="thesis_title" required maxlength="500" rows="4">${e(user.thesis_title)}</textarea>`)}<button class="primary" type="submit">Save thesis title</button></form><p class="small muted">Your supervisor sees the updated title. Discuss significant changes to your thesis scope together.</p></section><section class="panel padded"><h2>Meeting invitations</h2><form data-form="my-contact">${field('Contact email',`<input name="contact_email" type="email" maxlength="254" value="${e(user.contact_email||'')}" autocomplete="email">`)}<button class="primary" type="submit">Save email</button></form><p class="small muted">Use an email you can access. Teams calendar invitations are sent here; your sign-in username stays the same.</p></section>`;
  if (!isSupervisor()) return `<div class="settings-grid">${studentAccount}${account}</div>`;
  return `<div class="settings-grid">${account}<section class="panel padded"><h2>Connection</h2><p>${store.mode==='demo'?'You are using the local demo. No sample data is sent to Supabase.':'This browser is connected to your Supabase project. Private records are protected by account permissions.'}</p>${LOCAL?'<button class="secondary" data-action="connection">Change connection</button>':''}${store.mode==='live'?'<button class="text-button" data-action="copy-invite">Copy student sign-in link</button>':''}<p class="small muted">${store.backend?'Your session uses an HttpOnly cookie. Login tokens stay in the Supabase backend; refreshing the page keeps you signed in for up to eight hours.':'The website includes its public project URL and publishable key. This local connection keeps login tokens in memory only.'}</p></section>${LOCAL?`<section class="panel padded"><h2>Local testing</h2><p>The demo lets you try both roles with fictional records. PDFs and notes stay in this browser and do not sync to other devices.</p><button class="secondary" data-action="switch-demo">Open demo sign-in</button>${store.mode==='demo'?'<button class="text-button danger" data-action="reset-demo">Reset sample data</button>':''}</section>`:''}${store.mode==='live'?'<section class="panel padded"><h2>Deployment check</h2><p>Check the database, private PDF storage, and student account function.</p><button class="secondary" data-action="check-setup">Check production setup</button></section>':''}<section class="panel padded"><h2>Sign-in protection</h2><p>After repeated wrong passwords, sign-in is paused for that account or internet address. If a student is locked out, unblock them here.</p><button class="secondary" data-action="login-blocks">Show blocked sign-ins</button><p class="small muted">Resetting a student’s password also unblocks them. Blocks end on their own after 15 minutes to 4 hours.</p></section><section class="panel padded"><h2>Workspace backup</h2><p>Download all students, progress history, feedback, tasks, meetings, PDFs and PDF annotations. Archived students and dismissed updates are included.</p><button class="secondary" data-action="download-backup">Download workspace ZIP</button><p class="small muted">The archive is private and unencrypted. Extract it and open index.html to read progress offline. External Drive files, account passwords and Microsoft 365 contents are excluded. For large archives, use the private Windows backup tool.</p></section><section class="panel padded"><h2>Microsoft 365</h2><p>Booking and progress notifications are delivered through your university Power Automate flow. Approve a booked meeting to send the student a Teams calendar invitation.</p><button class="secondary" data-action="automation-status">Check connection &amp; queue</button><p class="small muted">The flow connection and its credentials stay in Supabase and Power Automate. Students add their invitation email in Account.</p></section><section class="panel padded"><h2>Meeting times</h2><p>All meeting dates and times use <strong>Europe/Tallinn</strong>, even if your device is set to another timezone.</p><p class="small muted">PDF limit: 20 MB. Drive links are supported when uploading is inconvenient.</p></section></div>`;
}
async function downloadWorkspaceBackup() {
  if (!isSupervisor()) return;
  const backupStore = store;
  dialog('Workspace backup', '<p id="backup-status" role="status">Preparing your backup…</p><p class="small muted">Keep this page open. The archive is checked before download; missing PDFs or changed records stop the backup.</p>');
  backupRunning = true;
  modal.querySelector('[data-action=close]').disabled = true;
  const status = modal.querySelector('#backup-status');
  const warn = event => { event.preventDefault(); event.returnValue = ''; };
  window.addEventListener('beforeunload', warn);
  try {
    const { ZipWriter, createWorkspaceArchive, verifyArchive } = await import('./thesis-backup.js?v=2026-10-21-signing-changes');
    const chunks = [], zip = new ZipWriter(bytes => chunks.push(bytes), 512 * 1024 * 1024);
    await createWorkspaceArchive({ mode: backupStore.mode, project: backupStore.project,
      snapshot: () => backupStore.backupSnapshot(), file: path => backupStore.backupFile(path) }, zip, text => { status.textContent = text; });
    status.textContent = 'Verifying the saved ZIP, record counts and PDF checksums…';
    const blob = new Blob(chunks, { type: 'application/zip' });
    const result = await verifyArchive(blob.size, async (start, length) => new Uint8Array(await blob.slice(start, start + length).arrayBuffer()));
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `thesis-workspace-${backupStore.mode==='demo'?'demo-':''}${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    status.textContent = `Verified and downloaded: ${result.counts.profiles} profiles, ${result.counts.reports} submissions, ${result.counts.comments} comments, ${result.counts.reviews} PDF reviews, ${result.counts.tasks} tasks, ${result.counts.slots} meeting slots, ${result.counts.signed||0} signed document versions, ${result.counts.notes||0} shared notes and ${result.files} files. Extract the ZIP and open index.html. Keep it in a private backup location.`;
  } catch (error) {
    status.textContent = `Backup failed: ${error.message} No complete archive was downloaded.`;
  } finally {
    backupRunning = false; window.removeEventListener('beforeunload', warn);
    modal.querySelector('[data-action=close]').disabled = false;
  }
}
function automationDialog(status) {
  const counts = status.counts || {};
  dialog('Microsoft 365 connection', `<p>${status.demo ? 'Local demo: no email or Teams meeting is sent.' : status.configured ? 'The private Power Automate webhook is configured.' : 'Microsoft 365 is not connected yet. Follow the local automation setup guide.'}</p><dl><dt>Waiting</dt><dd>${e((counts.pending||0)+(counts.processing||0))}</dd><dt>Accepted by Microsoft</dt><dd>${e(counts.accepted||0)}</dd><dt>Delivery errors</dt><dd>${e(counts.error||0)}</dd></dl><p class="small muted">Counts cover the last 14 days. Accepted means Microsoft received a request. Check Power Automate run history to confirm email and invitation delivery.</p>${status.configured ? '<button class="secondary" data-action="automation-retry">Retry failed deliveries &amp; process queue</button>' : ''}`);
}
function loginBlocksDialog(blocks) {
  const who = b => { const p = data.profiles.find(p => p.username === b.username); return p ? `${p.full_name} (@${p.username})` : `@${b.username} · not a workspace account`; };
  const what = b => b.scope === 'ip' ? 'Every username from this address' : b.scope === 'pair' ? `${who(b)} from this address` : `${who(b)} from any address`;
  dialog('Blocked sign-ins', blocks.length ? `<p class="muted">Unblocking a person clears all of their sign-in blocks. Unblock only people you recognise; an unknown username usually means someone is guessing.</p><div class="setup-checks">${blocks.map(b => `<div class="setup-check"><div class="row"><strong>${e(what(b))}</strong><button class="secondary small-button" data-action="unblock-login" data-id="${e(b.id)}">Unblock</button></div><p class="small muted">Address ${e(b.ip || 'any')} · blocked until ${e(dateText(b.blocked_until))} ${e(time(b.blocked_until))} (Europe/Tallinn)</p></div>`).join('')}</div>` : '<p>No accounts or addresses are blocked right now.</p>', true);
}
function setupDialog(checks) {
  dialog('Production setup check', `<p class="muted">These checks use your signed-in supervisor permissions.</p><div class="setup-checks">${checks.map(c=>`<div class="setup-check"><div class="row"><strong>${e(c.label)}</strong>${badge(c.ok?'Ready':'Needs attention',c.ok?'green':'amber')}</div><p>${e(c.detail)}</p></div>`).join('')}</div><p class="small muted">For any missing step, follow PRODUCTION.md in the repository. Before inviting students, also test two separate student accounts.</p>`, true);
}
function connectionDialog() {
  if (!canConfigure()) return;
  const config=getConnection();
  dialog('Connect your workspace',`<p class="muted">Enter the project URL and publishable key from Supabase. These are saved only in this browser.</p><form data-form="connection">${field('Project URL',`<input name="url" type="url" required placeholder="https://your-project.supabase.co" value="${e(config?.url||'')}">`)}${field('Publishable key',`<input name="key" required autocomplete="off" spellcheck="false" placeholder="sb_publishable_…" value="${e(config?.key||'')}">`)}<p class="small muted">Your supervisor must complete the Supabase setup before real accounts can sign in.</p>${actions('Save connection')}</form>${config?'<button class="text-button danger" data-action="clear-connection">Reset to website connection</button>':''}`);
}
function newReport() {
  dialog('Share your progress',`<form data-form="report">${field('Update title','<input name="title" required maxlength="160" placeholder="What have you been working on?">')}${field('Submission type','<select name="kind"><option value="progress">Progress update</option><option value="thesis">Thesis draft</option><option value="signed">Signed document (.asice)</option></select>')}${field('What are you uploading?',`<select name="document_type">${Object.entries(uploadTypes).map(([value,label])=>`<option value="${value}">${e(label)}</option>`).join('')}</select><small>Choose Thesis draft above for your main thesis PDF and its version comparison.</small>`,'upload-category')}${field('Progress notes','<textarea name="body" required minlength="10" maxlength="10000" rows="5" placeholder="What you completed, your next steps, and anything you need help with…"></textarea>')}${field('Attach a PDF (optional)','<input name="pdf" type="file" accept="application/pdf,.pdf"><small>PDF only · up to 20 MB</small>','pdf-field')}${field('Signed document (.asice)','<input name="asice" type="file" accept=".asice,application/vnd.etsi.asic-e+zip" disabled><small>A DigiDoc4 container you signed, up to 20 MB. Your supervisor can download it, add a signature and upload the signed version back.</small>','asice-field')}${field('Or add a sharing link (optional)','<input name="share_url" type="url" placeholder="https://…"><small>Personal or university Drive. Make sure your supervisor has permission to open it.</small>','link-field')}${actions('Submit progress')}</form>`);
  modal.querySelector('.asice-field').hidden = true;
}
function signedSection(r) {
  const files=[{path:r.file_path,name:r.file_name,by:r.created_by||r.student_id,at:r.created_at,label:'Original'},
    ...signedVersions(r.id).map((v,i)=>({path:v.file_path,name:v.file_name,by:v.uploaded_by,at:v.created_at,label:`Version ${i+2}`}))];
  const started=r.created_by&&r.created_by!==r.student_id?(isSupervisor()?'You started this document for the student. ':'Your supervisor started this document for you. '):'';
  const declined=changesRequested(r), awaiting=!declined&&latestSigner(r)===r.student_id;
  const notice=declined?`<p class="notice amber">${isSupervisor()?`You requested changes on ${e(dateText(r.signing_rejected_at))}. This document is out of your Awaiting feedback until the student uploads a new signed version.`:`Your supervisor requested changes on ${e(dateText(r.signing_rejected_at))} before signing. Read the feedback below, fix the document, sign it again in DigiDoc4 and upload the new version here.`}</p>`:'';
  return `<h3>Signed document</h3>${notice}<p class="small muted">${started}Every signature is kept as its own version. Download the latest version, add your signature in DigiDoc4, then upload the result here. DigiDoc4 also shows who has signed.</p><div class="signed-files">${files.map((f,i)=>`<div class="signed-file${i===files.length-1?' latest':''}"><div><strong>${e(f.label)}${i===files.length-1?' · latest':''}</strong><small>${e(f.name)} · ${e(uploader(f.by,r))} · ${e(dateText(f.at))}</small></div><button class="secondary small-button" data-action="download-file" data-path="${e(f.path)}" data-name="${e(f.name)}">Download</button></div>`).join('')}</div>${isSupervisor()||r.student_id===user.id?`<form data-form="signed-version" data-id="${e(r.id)}">${field('Upload a signed version (.asice)','<input name="asice" type="file" required accept=".asice,application/vnd.etsi.asic-e+zip">')}<button class="secondary" type="submit">Upload signed version</button></form>`:''}${isSupervisor()&&awaiting?`<form data-form="decline-signing" data-id="${e(r.id)}" class="decline-form">${field('Not ready to sign? Request changes','<textarea name="reason" required maxlength="9000" rows="3" placeholder="What the student should fix before you sign…"></textarea><small>The student gets this as feedback and an e-mail. The document leaves your Awaiting feedback until they upload a new signed version.</small>')}<button class="secondary danger" type="submit">Decline signing &amp; request changes</button></form>`:''}`;
}
function noteDialog(id) {
  const n=id?(data.notes||[]).find(n=>n.id===id&&n.student_id===user.id):null; if (id&&!n) return;
  dialog(n?'Edit note':'New note',`<form data-form="note" data-id="${e(n?.id||'')}">${field('Title (optional)',`<input name="title" maxlength="200" value="${e(n?.title||'')}">`)}${field('Note',`<textarea name="body" required maxlength="10000" rows="8" placeholder="Ideas, questions, reading notes, plans…">${e(n?.body||'')}</textarea>`)}<label class="check"><input type="checkbox" name="shared" ${n?.shared?'checked':''}> Share this note with my supervisor</label><p class="small muted">Private notes are visible only to you. Shared notes are read-only for your supervisor; you can stop sharing at any time.</p>${actions(n?'Save note':'Create note')}</form>${n?`<button class="text-button danger" data-action="delete-note" data-id="${e(n.id)}">Delete note</button>`:''}`);
}
function taskDialog(id) {
  const t=id?data.tasks.find(t=>t.id===id&&ownTask(t)&&t.student_id===user.id):null; if (id&&!t) return;
  dialog(t?'Edit next step':'Add a next step',`<form data-form="my-task" data-id="${e(t?.id||'')}">${field('Next step',`<input name="title" required maxlength="500" value="${e(t?.title||'')}" placeholder="A concrete next action">`)}${field('Due date (optional)',`<input name="due_date" type="date" value="${e(t?.due_date||'')}">`)}<p class="small muted">Your supervisor sees your next steps. Steps your supervisor assigned can only be ticked off.</p>${actions(t?'Save next step':'Add next step')}</form>${t?`<button class="text-button danger" data-action="delete-task" data-id="${e(t.id)}">Delete next step</button>`:''}`);
}
function signedDocumentDialog(studentId) {
  const p=data.profiles.find(p=>p.id===studentId&&p.role==='student'&&p.active); if (!p) return;
  if (modal.open&&!closeDialog()) return;
  dialog(`New signed document for ${p.full_name}`,`<form data-form="signed-document" data-id="${e(studentId)}">${field('Title','<input name="title" required maxlength="160" placeholder="e.g. Supervision agreement">')}${field('Note for the student','<textarea name="body" required minlength="10" maxlength="10000" rows="4" placeholder="What to check and sign, and by when…"></textarea>')}${field('Signed document (.asice)','<input name="asice" type="file" required accept=".asice,application/vnd.etsi.asic-e+zip"><small>Sign it in DigiDoc4 first. Up to 20 MB.</small>')}<p class="small muted">${store.mode==='demo'?'Demo only; no e-mail is sent.':p.contact_email?'The student gets an e-mail about it in a few minutes.':'The student has no e-mail address in Account, so they will see it in the workspace.'}</p>${actions('Share signed document')}</form>`);
}
function reportDialog(id) {
  const r=data.reports.find(r=>r.id===id); if (!r) return;
  const comments=data.comments.filter(c=>c.report_id===id).sort((a,b)=>a.created_at.localeCompare(b.created_at));
  dialog(r.title,`<p class="muted">${e(studentName(r.student_id))} · ${e(dateText(r.created_at))}</p><div class="prose">${e(r.body)}</div><div class="document-actions">${isSupervisor()?`<button class="secondary" data-action="${r.dismissed_at?'restore-report':'dismiss-report'}" data-id="${e(r.id)}">${r.dismissed_at?'Restore to overview':'Dismiss from overview'}</button>`:''}${isPdf(r)?`<button class="secondary" data-action="file" data-id="${e(r.id)}">▧ Open ${e(r.file_name)}</button>`:''}${isPdf(r)&&(isSupervisor()||pdfFeedback(id))?`<button class="${isSupervisor()?'primary':'secondary'}" data-action="pdf-review" data-id="${e(id)}">${isSupervisor()?'Review PDF & add feedback':'View PDF feedback'}</button>`:''}${r.kind==='thesis'&&r.file_path&&isSupervisor()?`<button class="secondary" data-action="pdf-compare" data-id="${e(id)}">Compare thesis versions</button>`:''}${safeShareURL(r.share_url)?`<a class="secondary" href="${e(safeShareURL(r.share_url))}" target="_blank" rel="noopener noreferrer">↗ Open shared document</a>`:''}</div>${isSigned(r)?signedSection(r):''}<h3>Supervisor feedback</h3>${pdfFeedback(id)?`<p class="notice green">PDF feedback shared on ${e(dateText(pdfFeedback(id).updated_at))}. Open ${isSupervisor()?'Review PDF & add feedback':'View PDF feedback'} to read the highlights and comments.</p>`:''}${comments.length?comments.map(c=>`<div class="comment"><div class="row"><strong>Supervisor</strong><small>${e(dateText(c.created_at))}</small></div><p class="prose">${e(c.body)}</p></div>`).join(''):'<p class="muted">No feedback yet.</p>'}${isSupervisor()?`<form data-form="comment" data-id="${e(id)}">${field('Leave a comment','<textarea name="body" rows="3" required maxlength="10000" placeholder="Feedback, decisions, and what to focus on next…"></textarea>')}<button class="primary" type="submit">Add feedback</button></form><hr><form data-form="task" data-id="${e(r.student_id)}">${field('Assign a next step','<input name="title" required maxlength="500" placeholder="A concrete next action">')}${field('Due date (optional)','<input name="due_date" type="date">')}<button class="secondary" type="submit">Add next step</button></form>`:''}`,true);
}
async function pdfDialog(id, compare = false) {
  const r = data.reports.find(r => r.id === id);
  if (!r?.file_path || (compare && (!isSupervisor() || r.kind !== 'thesis'))) return;
  if (modal.open && !closeDialog()) return;
  dialog(compare ? 'Compare thesis versions' : isSupervisor() ? 'Review PDF & add feedback' : 'PDF feedback', '<div id="pdf-workspace"><p role="status">Loading PDF tools...</p></div>', true);
  modal.classList.add('pdf-dialog');
  const root = modal.querySelector('#pdf-workspace');
  try {
    const { openComparison, openReview } = await import('./thesis-pdf.js?v=2026-10-21-signing-changes');
    if (!root.isConnected || !modal.open) return;
    pdfSession = compare ? openComparison(root, { store, report: r, reports: data.reports }) : openReview(root, {
      store, report: r, readonly: !isSupervisor(), onError: err => toast(err.message, true),
      onShared: saved => { data.reviews ||= []; const old = pdfFeedback(id); if (old) Object.assign(old, saved); else data.reviews.push(saved); render(); toast(`PDF feedback shared. ${feedbackNotice(id)}`); }
    });
  } catch (err) { if (root.isConnected) { root.textContent = err.message; toast(err.message, true); } }
}
function addStudent() {
  dialog('Create a student account',`<form data-form="student">${field('Full name','<input name="full_name" required maxlength="120" autocomplete="off">')}${field('Username','<input name="username" required pattern="[a-z0-9][a-z0-9._-]{2,31}" minlength="3" maxlength="32" autocomplete="off" placeholder="e.g. anna.s"><small>3–32 lowercase letters, numbers, dots, underscores or hyphens.</small>')}${field('Initial password','<input name="password" type="password" required minlength="12" maxlength="128" autocomplete="new-password"><small>At least 12 characters. Share it privately with the student.</small>')}${field('Thesis title','<textarea name="thesis_title" rows="2" maxlength="500"></textarea>')}${field('Expected defence month (optional)','<input name="expected_defence" type="month">')}${actions('Create account')}</form>`);
}
function importDialog() {
  if (!isSupervisor()) return;
  studentImport = null;
  dialog('Import student accounts', `<p>Select the private JSON account list prepared for your students. Review the names, theses and expected defence months before creating accounts.</p><p class="small muted">Existing usernames, including archived accounts, are skipped. Their profiles and passwords are kept. Temporary passwords are sent only when creating a new account.</p>${field('Student account list', '<input name="student-import-file" type="file" accept=".json,application/json">')}<p class="small muted">Up to 100 students, file size up to 1 MB. Keep this file private.</p><div id="student-import-preview"></div>`, true);
}
function readStudentImport(text) {
  let payload;
  try { payload = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('Choose a valid JSON student account list.'); }
  if (!payload || payload.version !== 1 || !Array.isArray(payload.students) || !payload.students.length || payload.students.length > 100 || Object.keys(payload).some(k => !['version', 'students'].includes(k))) throw new Error('Use a version 1 account list with 1–100 students.');
  const seen = new Set();
  return payload.students.map((row, index) => {
    const invalid = message => { throw new Error(`Student ${index + 1}: ${message}`); };
    const keys = ['full_name', 'username', 'password', 'thesis_title', 'expected_defence'];
    if (!row || Array.isArray(row) || typeof row !== 'object' || Object.keys(row).some(k => !keys.includes(k)) || keys.some(k => typeof row[k] !== 'string')) invalid('check the account fields.');
    const full_name = row.full_name.trim(), username = row.username.trim().toLowerCase(), thesis_title = row.thesis_title.trim(), expected_defence = row.expected_defence.trim();
    if (!full_name || full_name.length > 120 || thesis_title.length > 500) invalid('check the full name and thesis title.');
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) invalid('use a valid username of 3–32 characters.');
    if (seen.has(username)) invalid('the account list contains a duplicate username.');
    seen.add(username);
    if (row.password.length < 12 || row.password.length > 128) invalid('use a temporary password of 12–128 characters.');
    const defence_date = defenceDate(expected_defence);
    return { full_name, username, thesis_title, expected_defence, defence_date, password: row.password, status: 'pending', detail: '' };
  });
}
function renderImport() {
  const target = modal.querySelector('#student-import-preview'); if (!target || !studentImport) return;
  const { rows, running, done } = studentImport;
  const count = status => rows.filter(row => row.status === status).length;
  const candidates = rows.filter(row => row.status === 'pending').length;
  const controls = `<div class="form-actions">${done ? '<button class="secondary" data-action="download-import-results">Download results</button>' : ''}<button class="secondary" data-action="close" ${running ? 'disabled' : ''}>${done ? 'Close' : 'Cancel'}</button>${!done ? `<button class="primary" data-action="create-import" ${running || !candidates ? 'disabled' : ''}>Create ${candidates} accounts</button>` : ''}</div>`;
  target.innerHTML = `<p role="status" id="student-import-status">${running ? 'Creating accounts… Keep this page open.' : done ? `Finished: ${count('created')} created, ${count('skipped')} skipped, ${count('failed')} need attention.` : `${rows.length} students loaded; ${candidates} new accounts to create.`}</p>${controls}<div class="table-wrap"><table class="student-table"><caption class="sr-only">Student import preview</caption><thead><tr><th>Student</th><th>Thesis</th><th>Expected defence</th><th>Status</th></tr></thead><tbody>${rows.map(row => `<tr><td><strong>${e(row.full_name)}</strong><br><small>@${e(row.username)}</small></td><td class="title-cell" data-label="Thesis">${e(row.thesis_title)}</td><td data-label="Expected defence">${row.defence_date ? e(defenceText(row.defence_date)) : '—'}</td><td data-label="Status">${badge(row.status, row.status === 'created' ? 'green' : row.status === 'failed' ? 'amber' : '')}</td></tr>`).join('')}</tbody></table></div>${done ? '<p class="small muted">Use the temporary password from your private account list only for rows marked created. Skipped accounts keep their existing password. If a request failed, check the student list before retrying, and check your project’s password requirements.</p>' : ''}`;
  modal.querySelector('[data-action="close"]').disabled = running;
  modal.querySelector('[name="student-import-file"]').disabled = running || done;
}
async function createImport() {
  if (!isSupervisor() || !studentImport || studentImport.running || studentImport.done) return;
  const batch = studentImport;
  batch.running = true; renderImport();
  try {
    // Refresh before creating to avoid overwriting accounts added since the preview.
    await refresh();
    for (const row of batch.rows) if (data.profiles.some(p => p.username === row.username)) { row.status = 'skipped'; row.detail = 'Username already exists; kept unchanged.'; row.password = ''; }
    for (const row of batch.rows) {
      if (row.status !== 'pending') continue;
      try {
        await store.account('create', { full_name: row.full_name, username: row.username, thesis_title: row.thesis_title, defence_date: row.defence_date, password: row.password });
        row.status = 'created';
      } catch { row.status = 'failed'; row.detail = 'Check whether the username already exists and whether the password meets project requirements.'; }
      // The import file remains with the supervisor; passwords are not used in the result export.
      row.password = ''; renderImport();
    }
    batch.done = true;
    await refresh();
  } finally {
    batch.running = false;
    renderImport();
  }
}
function downloadImportResults() {
  if (!isSupervisor() || !studentImport?.done) return;
  const result = studentImport.rows.map(({ full_name, username, expected_defence, status, detail }) => ({ full_name, username, expected_defence, status, detail }));
  const url = URL.createObjectURL(new Blob([JSON.stringify({ students: result }, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'thesis-import-results.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function studentDialog(id) {
  const p=data.profiles.find(p=>p.id===id); if (!p) return;
  dialog(p.full_name,`<p class="muted">@${e(p.username)} · ${p.active?'Active':'Archived'}</p><h3>${e(p.thesis_title||'Title to be agreed')}</h3><p>${p.defence_date?'Expected defence: '+e(defenceText(p.defence_date)):''}</p><div class="document-actions"><button class="secondary" data-action="password" data-id="${e(id)}">Reset password</button><button class="secondary ${p.active?'danger':''}" data-action="archive" data-id="${e(id)}">${p.active?'Archive account':'Restore account'}</button>${p.active?`<button class="secondary" data-action="signed-document" data-id="${e(id)}">✎ New signed document</button>`:''}</div><p class="small muted">Archiving removes sign-in access and releases future bookings. Reports and feedback are retained.</p><h3>Progress history</h3>${sortedReports().filter(r=>r.student_id===id).map(reportCard).join('')||'<p class="muted">No updates yet.</p>'}<h3>Shared notes</h3>${(data.notes||[]).filter(n=>n.student_id===id&&n.shared).sort((a,b)=>b.updated_at.localeCompare(a.updated_at)).map(n=>`<div class="comment"><div class="row"><strong>${e(n.title||'Note')}</strong><small>${e(dateText(n.updated_at))}</small></div><p class="prose">${e(n.body)}</p></div>`).join('')||'<p class="muted">No shared notes. Students\' private notes are not visible to you.</p>'}<h3>Next steps</h3>${taskList(data.tasks.filter(t=>t.student_id===id))}<form data-form="task" data-id="${e(id)}">${field('New next step','<input name="title" required maxlength="500">')}${field('Due date (optional)','<input name="due_date" type="date">')}<button class="primary">Assign next step</button></form>`,true);
}
function zonedTime(day, clock) {
  const [y,m,d]=day.split('-').map(Number), [h,min]=clock.split(':').map(Number); const target=Date.UTC(y,m-1,d,h,min); let guess=target;
  for (let i=0;i<3;i++) { const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(guess)).map(p=>[p.type,p.value])); const actual=Date.UTC(+parts.year,+parts.month-1,+parts.day,+parts.hour,+parts.minute,+parts.second); guess+=target-actual; }
  if (dateKey(new Date(guess))!==day || time(new Date(guess))!==clock) throw new Error('This time is not available because of the daylight-saving clock change.');
  return new Date(guess).toISOString();
}
function availabilityDialog() {
  dialog('Add meeting availability',`<p class="muted">Create consecutive meeting slots. Times use Europe/Tallinn.</p><form data-form="availability">${field('Date',`<input name="date" type="date" required min="${dateKey(new Date())}" value="${selectedDay}">`)}<div class="two-columns">${field('From','<input name="from" type="time" required value="14:00">')}${field('Until','<input name="until" type="time" required value="16:00">')}</div>${field('Slot length','<select name="duration"><option value="30">30 minutes</option><option value="45">45 minutes</option><option value="60">60 minutes</option></select>')}${field('Location or meeting link','<input name="location" required maxlength="200" value="MS Teams">')}${actions('Publish availability')}</form>`);
}
function bookDialog(id) { const s=data.slots.find(s=>s.id===id); if (!s) return; dialog('Book a supervision meeting',`<p>${e(dateText(s.starts_at))} · ${e(time(s.starts_at))}–${e(time(s.ends_at))}<br><span class="muted">${e(s.location)} · Europe/Tallinn</span></p><form data-form="book" data-id="${e(id)}">${field('What would you like to discuss?','<textarea name="agenda" required maxlength="2000" rows="4" placeholder="Your progress, questions, or decisions to discuss…"></textarea>')}${field('Email for your Teams invitation',`<input name="contact_email" type="email" required maxlength="254" value="${e(user.contact_email||'')}" autocomplete="email"><small>Your supervisor approves the meeting before a Teams invitation is emailed.</small>`)}${actions('Confirm booking')}</form>`); }
function meetingDialog(id) {
  const s=data.slots.find(s=>s.id===id); if (!s) return;
  dialog('Supervision meeting',`<p><strong>${e(dateText(s.starts_at))} · ${e(time(s.starts_at))}–${e(time(s.ends_at))}</strong><br><span class="muted">${isSupervisor()?e(studentName(s.booked_by))+' · ':''}${e(s.location)} · Europe/Tallinn</span></p>${s.teams_requested_at?`<div class="notice ${s.teams_dispatch_state==='error'?'amber':'green'}">${s.teams_dispatch_state==='error'?'Invitation delivery needs attention. Your supervisor can retry from Settings.':s.teams_dispatch_state==='accepted'?'Invitation request sent to Microsoft 365. Check your email for the Teams calendar invitation.':'Teams invitation is queued for Microsoft 365.'}${store.mode==='demo'?' Demo only; no invitation is sent.':''}</div>`:''}${isSupervisor()&&new Date(s.starts_at)>new Date()?`<p class="small muted">Invitation email: ${e(data.profiles.find(p=>p.id===s.booked_by)?.contact_email||'The student must add an email in Account.')}</p>${!s.teams_requested_at?`<button class="primary" data-action="request-teams" data-id="${e(id)}">Create Teams meeting &amp; send invitation</button>`:''}`:''}<h3>Meeting agenda</h3><p class="prose">${e(s.agenda||'No agenda added.')}</p><h3>Meeting notes</h3>${isSupervisor()?`<form data-form="meeting-notes" data-id="${e(id)}">${field('Discussion, decisions, and next steps',`<textarea name="notes" rows="5" maxlength="10000">${e(s.meeting_notes)}</textarea>`)}<button class="primary">Save meeting notes</button></form>`:`<p class="prose">${e(s.meeting_notes||'Your supervisor has not added meeting notes yet.')}</p>`}${new Date(s.starts_at)>new Date()?`<button class="text-button danger" data-action="cancel" data-id="${e(id)}">Cancel booking</button>`:''}`);
}

document.addEventListener('click', async event => {
  const button=event.target.closest('[data-action]'); if (!button) return;
  const action=button.dataset.action, id=button.dataset.id;
  if (action==='close') { if (!studentImport?.running) closeDialog(); return; }
  if (['login-blocks', 'unblock-login', 'download-backup', 'request-teams', 'automation-status', 'automation-retry', 'dismiss-report', 'restore-report', 'dismiss-all', 'import-students', 'create-import', 'download-import-results', 'add-student', 'student', 'password', 'archive', 'signed-document'].includes(action) && !isSupervisor()) return;
  if (['new-note', 'note', 'delete-note', 'new-task', 'edit-task', 'delete-task'].includes(action) && isSupervisor()) return;
  if (action==='import-students') return importDialog();
  if (action==='download-import-results') return downloadImportResults();
  if (['connection','clear-connection'].includes(action) && !canConfigure()) return;
  if (['copy-invite','switch-demo','reset-demo','check-setup'].includes(action) && !isSupervisor()) return;
  if (action==='demo' && (!DEMO || user)) return;
  if (action==='live' && (!DEMO || user)) return;
  if (action==='connection') return connectionDialog();
  if (!LOCAL && ['demo','switch-demo','reset-demo'].includes(action)) return;
  if (action==='view') { view=button.dataset.view; render(); window.scrollTo(0,0); app.querySelector('.page-title')?.focus({preventScroll:true}); return; }
  if (action==='day') { selectedDay=button.dataset.day; return render(); }
  if (action==='toggle-past-meetings') { showPastMeetings=!showPastMeetings; return render(); }
  if (action==='month') { const [y,m]=month.split('-').map(Number); month=new Date(Date.UTC(y,m-1+Number(button.dataset.offset),1)).toISOString().slice(0,7); return render(); }
  if (action==='new-report') return newReport();
  if (action==='pdf-review' || action==='pdf-compare') return pdfDialog(id, action==='pdf-compare');
  if (action==='report') { if (modal.open && !closeDialog()) return; return reportDialog(id); }
  if (action==='student') return studentDialog(id);
  if (action==='add-student') return addStudent();
  if (action==='availability') return availabilityDialog();
  if (action==='book') return bookDialog(id);
  if (action==='meeting') return meetingDialog(id);
  if (action==='new-note') return noteDialog();
  if (action==='note') { if (modal.open && !closeDialog()) return; return noteDialog(id); }
  if (action==='new-task') return taskDialog();
  if (action==='edit-task') { if (modal.open && !closeDialog()) return; return taskDialog(id); }
  if (action==='signed-document') return signedDocumentDialog(id);
  if (action==='password') { closeDialog(); return dialog('Reset student password',`<form data-form="password" data-id="${e(id)}">${field('New password','<input name="password" type="password" required minlength="12" maxlength="128" autocomplete="new-password">')}${actions('Reset password')}</form>`); }
  await busy(button, async()=>{
    if (action==='download-backup') { await downloadWorkspaceBackup(); return; }
    if (action==='login-blocks') { loginBlocksDialog(await store.loginBlocks()); return; }
    if (action==='unblock-login') { await store.unblockLogin({target_id:id}); const blocks=await store.loginBlocks(); closeDialog(); loginBlocksDialog(blocks); toast('Sign-in unblocked. They can try again now.'); return; }
    if (action==='dismiss-report'||action==='restore-report') { await store.dismissReport(id,action==='dismiss-report'); closeDialog(); await refresh(); toast(action==='dismiss-report'?'Update dismissed. Its history and files are retained.':'Update restored to overview.'); return; }
    if (action==='dismiss-all') { await store.dismissAllReports(); await refresh(); toast('Overview cleared. Progress history and files are retained.'); return; }
    if (action==='automation-status') { automationDialog(await store.automation('status')); return; }
    if (action==='automation-retry') { const result=await store.automation('retry'); closeDialog(); await refresh(); toast(result.demo?'Demo only; no emails are sent.':result.errors?'Some deliveries still need attention. Check Power Automate.':'Queue processed. Check Power Automate run history for delivery.',Boolean(result.errors)); return; }
    if (action==='request-teams') { const result=await store.automation('request_teams',{slot_id:id}); closeDialog(); await refresh(); meetingDialog(id); toast(result.demo?'Demo request saved. No invitation is sent.':'Teams invitation queued. Microsoft 365 sends it to the student by email.'); return; }
    if (action==='create-import') { await createImport(); return; }
    if (action==='live') { await store?.logout(); store?.dispose(); location.assign(location.pathname + (getConnection()?'':'?setup=1')); return; }
    if (action==='check-setup' && isSupervisor() && store.mode==='live') setupDialog(await store.checkSetup());
    if (action==='demo') { store?.dispose(); store=new DemoStore(); localStorage.setItem('thesis.mode.v1','demo'); user=await store.login(button.dataset.role==='supervisor'?'ali':'alex','demo-thesis-2026'); view='overview'; await refresh(); }
    if (action==='logout') { await store.logout(); user=null; render(); }
    if (action==='copy-invite' && store.mode==='live') { await navigator.clipboard.writeText('https://ali.cyberwise.ee/thesis-manager.html'); toast('Website link copied. Send students their username and initial password privately.'); }
    if (action==='refresh') { await refresh(); toast('Workspace refreshed.'); }
    if (action==='archive') { const p=data.profiles.find(p=>p.id===id); if (!confirm(`${p.active?'Archive':'Restore'} ${p.full_name}? ${p.active?'Their reports will be retained.':''}`)) return; const result=await store.account(p.active?'archive':'restore',{student_id:id}); closeDialog(); await refresh(); toast(result?.warning||'Account updated.',Boolean(result?.warning)); }
    if (action==='delete-slot') { if (!confirm('Remove this available meeting slot?')) return; await store.deleteSlot(id); await refresh(); toast('Slot removed.'); }
    if (action==='cancel') { if (!confirm('Cancel this booking and make the slot available again?')) return; await store.cancel(id); closeDialog(); await refresh(); toast('Booking cancelled.'); }
    if (action==='file') { const win=window.open('about:blank','_blank'); if (win) win.opener=null; try { const url=await store.fileURL(data.reports.find(r=>r.id===id)); if (win) win.location.replace(url); else toast('Allow pop-ups to open the PDF.',true); if(url.startsWith('blob:'))setTimeout(()=>URL.revokeObjectURL(url),300000); } catch(err) { win?.close(); throw err; } }
    if (action==='download-file') {
      const blob=await store.fileBlob(button.dataset.path), url=URL.createObjectURL(blob), link=document.createElement('a');
      link.href=url; link.download=button.dataset.name||'signed-document.asice'; link.click(); setTimeout(()=>URL.revokeObjectURL(url),60000);
    }
    if (action==='delete-note') { if (!confirm('Delete this note? This cannot be undone.')) return; await store.deleteNote(id); closeDialog(); await refresh(); toast('Note deleted.'); }
    if (action==='delete-task') { if (!confirm('Delete this next step?')) return; await store.deleteMyTask(id); closeDialog(); await refresh(); toast('Next step deleted.'); }
    if (action==='switch-demo') { await store.logout(); store.dispose(); location.assign(location.pathname+'?demo=1'); return; }
    if (action==='clear-connection') { await store?.logout(); store?.dispose(); clearConnection(); localStorage.setItem('thesis.mode.v1','live'); store=new SupabaseStore(getConnection()); user=null; closeDialog(); render(); }
    if (action==='reset-demo') { if (!confirm('Delete this browser’s demo records and files and restore the samples?')) return; await store.logout(); localStorage.removeItem('thesis.demo.v1'); await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase('thesis-demo-files');r.onsuccess=resolve;r.onerror=()=>reject(r.error);}); user=null; await store.init(); render(); toast('Demo reset.'); }
  });
});
document.addEventListener('submit', event => {
  const form=event.target.closest('[data-form]'); if (!form) return; event.preventDefault();
  const values=Object.fromEntries(new FormData(form));
  busy(form.querySelector('[type="submit"],button:not([type])'),async()=>{
    const type=form.dataset.form;
    if (type==='login') { if (!store) throw new Error('Open your workspace sign-in link first to connect this browser.'); user=await store.login(values.username,values.password); view='overview'; try { await refresh(); } catch(err) { user=null; await store.logout(); render(); throw err; } return; }
    if (type==='connection') { if (!canConfigure()) return; setConnection(values.url,values.key); await store?.logout(); store?.dispose(); store=new SupabaseStore(getConnection()); localStorage.setItem('thesis.mode.v1','live'); user=null; closeDialog(); location.assign(location.pathname); return; }
    if (type==='my-thesis') { await store.updateMyThesis(values.thesis_title); await refresh(); toast('Your thesis title has been updated.'); return; }
    if (type==='my-contact') { await store.updateMyContact(values.contact_email); await refresh(); toast('Your contact email has been updated.'); return; }
    if (type==='my-profile') { await store.updateMyProfile(values.full_name); await refresh(); toast('Your name has been updated.'); return; }
    if (type==='my-password') { await store.changeMyPassword(values.current_password,values.new_password,values.confirm_password); form.reset(); toast('Password changed. Use your new password next time you sign in.'); return; }
    if (type==='student') { if (!isSupervisor()) return; await store.account('create',{full_name:values.full_name,password:values.password,thesis_title:values.thesis_title,defence_date:defenceDate(values.expected_defence),username:values.username.trim().toLowerCase()}); toast('Student account created. Share the login privately.'); }
    if (type==='password') {
      await store.account('password',{student_id:form.dataset.id,password:values.password});
      // A reset also reopens sign-in; the password change stands even if that step is unavailable.
      const username=data.profiles.find(p=>p.id===form.dataset.id)?.username;
      try { if (username) await store.unblockLogin({target_username:username}); toast('Password reset. Any sign-in block for this student was cleared.'); }
      catch { toast('Password reset. Check Settings → Sign-in protection if the student is still blocked.', true); }
    }
    if (type==='report' && values.kind==='signed') { const file=values.asice?.size?values.asice:null; await validateAsice(file); await store.submitReport({title:values.title.trim(),kind:'progress',document_type:'signed',body:values.body.trim(),share_url:null},file); toast('Your signed document has been shared.'); }
    else if (type==='report') { const file=values.pdf?.size?values.pdf:null; await validatePDF(file); const link=httpsURL(values.share_url); await store.submitReport({title:values.title.trim(),kind:values.kind,document_type:values.kind==='thesis'?'thesis':values.document_type||'other',body:values.body.trim(),share_url:link},file); toast('Your progress has been shared.'); }
    if (type==='signed-version') {
      const r=data.reports.find(r=>r.id===form.dataset.id); if (!r) return;
      await store.addSignedVersion(r, values.asice?.size?values.asice:null);
      closeDialog(); await refresh(); reportDialog(r.id);
      toast(isSupervisor()?`Signed version uploaded. ${feedbackNotice(r.id)}`:`Signed version uploaded. ${store.mode==='demo'?'Demo only; no e-mail is sent.':'Your supervisor gets an e-mail about it.'}`); return;
    }
    if (type==='decline-signing') {
      if (!isSupervisor()) return; const id=form.dataset.id;
      await store.requestSignatureChanges(id, values.reason);
      closeDialog(); await refresh(); reportDialog(id); toast(`Changes requested. ${feedbackNotice(id)}`); return;
    }
    if (type==='signed-document') { await store.createSignedDocument(form.dataset.id,values.title.trim(),values.body.trim(),values.asice?.size?values.asice:null); toast('Signed document shared with the student.'); }
    if (type==='note') { await store.saveNote(form.dataset.id||null,values.title||'',values.body,values.shared==='on'); toast(values.shared==='on'?'Note saved and shared with your supervisor.':'Note saved. Only you can see it.'); }
    if (type==='my-task') { if (form.dataset.id) await store.updateMyTask(form.dataset.id,values.title.trim(),values.due_date); else await store.task(user.id,values.title.trim(),values.due_date); toast(form.dataset.id?'Next step updated.':'Next step added.'); }
    if (type==='comment') { await store.comment(form.dataset.id,values.body.trim()); const id=form.dataset.id; closeDialog(); await refresh(); reportDialog(id); toast(`Feedback added. ${feedbackNotice(id)}`); return; }
    if (type==='task') { await store.task(form.dataset.id,values.title.trim(),values.due_date); toast('Next step added.'); }
    if (type==='book') { if (values.contact_email.trim().toLowerCase()!==user.contact_email) await store.updateMyContact(values.contact_email); await store.book(form.dataset.id,values.agenda.trim()); toast('Meeting booked.'); }
    if (type==='meeting-notes') { await store.meetingNotes(form.dataset.id,values.notes.trim()); toast('Meeting notes saved.'); }
    if (type==='availability') {
      const start=new Date(zonedTime(values.date,values.from)), end=new Date(zonedTime(values.date,values.until)), step=Number(values.duration)*60000;
      if (start<=new Date() || end<=start || +end-+start>8*3600000) throw new Error('Choose a future time range of up to eight hours, with the end after the start.');
      if ((+end-+start)%step) throw new Error('The time range must fit whole meeting slots.');
      const slots=[];for(let t=+start;t<+end;t+=step)slots.push({starts_at:new Date(t).toISOString(),ends_at:new Date(t+step).toISOString(),location:values.location.trim()});
      await store.createSlots(slots); selectedDay=values.date; month=values.date.slice(0,7); toast(`${slots.length} meeting slots published.`);
    }
    closeDialog(); await refresh();
  });
});
document.addEventListener('change', event=>{
  if (event.target.name==='kind' && event.target.closest('[data-form="report"]')) {
    const form = event.target.form, kind = event.target.value;
    const category = form.querySelector('.upload-category');
    category.hidden = kind!=='progress'; category.querySelector('select').disabled = category.hidden;
    // A signed document is an .asice upload instead of a PDF or sharing link.
    for (const [selector, show] of [['.pdf-field', kind!=='signed'], ['.link-field', kind!=='signed'], ['.asice-field', kind==='signed']]) {
      const wrapper = form.querySelector(selector); wrapper.hidden = !show; wrapper.querySelector('input').disabled = !show;
    }
    form.querySelector('.asice-field input').required = kind==='signed';
  }
  if (event.target.name==='asice' && event.target.files[0]) validateAsice(event.target.files[0]).catch(err=>{event.target.value='';toast(err.message,true);});

  if (event.target.name==='student-import-file') {
    const input = event.target, file = input.files[0];
    if (!isSupervisor() || loading || studentImport?.running || studentImport?.done) return;
    studentImport = null; modal.querySelector('#student-import-preview').innerHTML = '';
    if (!file) return;
    input.disabled = true;
    busy(null, async()=>{
      try {
        if (file.size > 1048576) throw new Error('Choose an account list smaller than 1 MB.');
        const rows = readStudentImport(await file.text());
        if (!input.isConnected || input.files[0] !== file || !isSupervisor()) return;
        for (const row of rows) if (data.profiles.some(p => p.username === row.username)) { row.status = 'skipped'; row.detail = 'Username already exists; kept unchanged.'; row.password = ''; }
        studentImport = { rows, running: false, done: rows.every(row => row.status === 'skipped') }; renderImport();
      } finally { if (input.isConnected && !studentImport?.done) input.disabled = false; }
    });
  }
  if (event.target.id==='show-archived') { showArchived=event.target.checked; render(); }
  if (event.target.dataset.task) { const input=event.target, checked=input.checked; busy(null,async()=>{try { await store.completeTask(input.dataset.task,checked); await refresh(); if(modal.open)closeDialog(); } catch(err) { input.checked=!checked; throw err; }}); }
  if (event.target.name==='pdf') validatePDF(event.target.files[0]).catch(err=>{event.target.value='';toast(err.message,true);});
});
document.addEventListener('input', event=>{
  if (event.target.id==='student-search') {
    studentFilter=event.target.value;
    // Keep the native input intact so typing, selection and undo retain their place.
    document.querySelector('#student-results').innerHTML=studentResults();
  }
});
modal.addEventListener('click', event=>{if(!studentImport?.running&&event.target===modal&&event.clientX<modal.getBoundingClientRect().left)closeDialog();});
modal.addEventListener('cancel', event => { event.preventDefault(); if (!studentImport?.running) closeDialog(); });

// An invitation opened in the current tab changes only the fragment. Restart once
// so startup validates and saves it, just as it does on a fresh page visit.
window.addEventListener('hashchange', () => {
  const invitation = new URLSearchParams(location.hash.slice(1));
  if (invitation.has('url') && invitation.has('key')) location.reload();
});

async function start() {
  if (!LOCAL && location.protocol==='http:') { location.replace('https:'+location.href.slice(5)); return; }
  try {
    const invitation=new URLSearchParams(location.hash.slice(1));
    if (invitation.has('url') && invitation.has('key')) {
      if (LOCAL) setConnection(invitation.get('url'),invitation.get('key'));
      localStorage.setItem('thesis.mode.v1','live'); history.replaceState(null,'',location.pathname+location.search);
    }
    const config=getConnection();
    if(DEMO && !invitation.has('url'))store=new DemoStore();else if(config) { store=new SupabaseStore(config); localStorage.setItem('thesis.mode.v1','live'); } else localStorage.removeItem('thesis.mode.v1');
    if(store)user=await store.currentUser();
    if(user)await refresh();else { render(); if(SETUP)connectionDialog(); }
  } catch(err) { user=null;render();toast(err.message,true); }
}
start();
