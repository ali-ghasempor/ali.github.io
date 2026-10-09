// The browser receives profiles and data; Supabase Auth tokens stay in the backend.
export class BackendSession {
  constructor(config) {
    const endpoint = new URL(config.backend);
    if (endpoint.origin !== new URL(config.url).origin || endpoint.pathname !== '/functions/v1/thesis-api' || endpoint.search || endpoint.hash)
      throw new Error('The workspace backend URL is invalid.');
    this.endpoint = endpoint.href;
    this.project = new URL(config.url).origin;
    this.publishableKey = config.key;
    this.expiresAt = 0;
  }
  async request(path, options = {}) {
    const headers = new Headers(options.headers);
    headers.set('X-Thesis-Request', '1');
    headers.set('apikey', this.publishableKey);
    return fetch(this.endpoint + path, { ...options, headers, credentials: 'include', cache: 'no-store', redirect: 'error' });
  }
  async json(path, values) {
    const response = await this.request(path, values === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values)
    });
    let result;
    try { result = await response.json(); } catch { throw new Error('The workspace backend is unavailable. Ask your supervisor to check its deployment.'); }
    if (!response.ok) throw new Error(result.error || result.message || 'The workspace request failed.');
    return result;
  }
  async session() {
    const result = await this.json('/session');
    this.expiresAt = result.expires_at || 0;
    return result.profile;
  }
  async login(username, password) {
    await this.json('/login', { username, password });
    // Confirm the browser accepted the HttpOnly cookie before showing a signed-in workspace.
    const profile = await this.session();
    if (!profile) throw new Error('This browser blocked the workspace cookie. Update your browser and allow workspace cookies, then try again.');
    return profile;
  }
  async logout() { await this.json('/logout', {}); this.expiresAt = 0; }
  // Reports a browser-side error for monitoring. Never throws: reporting must not cause new errors.
  reportError(details) {
    this.request('/client-error', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(details) })
      .then(response => response.body?.cancel(), () => undefined);
  }
  async changePassword(current_password, password) {
    const result = await this.json('/password', { current_password, password });
    this.expiresAt = result.expires_at || 0;
  }
  async ensureSession() {
    if (this.expiresAt * 1000 > Date.now() + 60000) return true;
    if (!this.refreshing) this.refreshing = this.session().finally(() => { this.refreshing = null; });
    return Boolean(await this.refreshing);
  }
  async fetch(input, init = {}) {
    const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (target.origin !== this.project) throw new Error('Unexpected workspace API destination.');
    if (!await this.ensureSession()) return Response.json({ message: 'Your session has ended. Sign in again.', code: 'SESSION_EXPIRED' }, { status: 401 });
    const original = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    const headers = new Headers();
    // Only transport headers cross the gateway; identity comes from the HttpOnly cookie.
    for (const name of ['content-type', 'accept', 'prefer', 'range', 'range-unit', 'x-upsert', 'x-client-info'])
      if (original.has(name)) headers.set(name, original.get(name));
    return this.request('/proxy?path=' + encodeURIComponent(target.pathname + target.search), {
      ...init, headers
    });
  }
}
