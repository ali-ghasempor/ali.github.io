// Public browser configuration. Never add passwords or Supabase secret/service-role keys here.
export const PUBLIC_SUPABASE_CONFIG = Object.freeze({
  url: 'https://joabghjqczbwmfetbqge.supabase.co',
  key: 'sb_publishable_C_p_2ZxfK2mSX-NaR9M4Yw_0_tiXGNI',
  backend: 'https://joabghjqczbwmfetbqge.supabase.co/functions/v1/thesis-api',
  // The same gateway served from the published site itself (Cloudflare Worker), so its cookie is first-party.
  siteBackend: 'https://ali.cyberwise.ee/api/thesis'
});
