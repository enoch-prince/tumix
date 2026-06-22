/**
 * Tu-mix Email Capture Worker
 * Stores subscriber emails in Cloudflare KV.
 *  * Deploy with: npx wrangler deploy
 */

const ALLOWED_ORIGINS = [
  'https://tu-mix.com',
  'https://www.tu-mix.com',
  'https://tumix.pages.dev',
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin':  allowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
    'Access-Control-Max-Age':       '86400',
  };
}

function json(data, status = 200, origin = ALLOWED_ORIGINS[0]) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

function isValidEmail(email) {
  return typeof email === 'string'
    && email.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim().toLowerCase());
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || ALLOWED_ORIGINS[0];
    const url    = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // POST /subscribe
    if (request.method === 'POST' && url.pathname === '/subscribe') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: 'Invalid JSON body.' }, 400, origin);
      }

      const email = (body.email || '').trim().toLowerCase();

      if (!isValidEmail(email)) {
        return json({ ok: false, error: 'Please enter a valid email address.' }, 400, origin);
      }

      const existing = await env.TUMIX_EMAILS.get(`email:${email}`);
      if (existing) {
        return json({ ok: true, message: 'You are on the list.' }, 200, origin);
      }

      const subscribedAt = new Date().toISOString();
      await env.TUMIX_EMAILS.put(`email:${email}`, subscribedAt);
      await env.TUMIX_EMAILS.put(`index:${subscribedAt}:${email}`, email);

      return json({ ok: true, message: 'You are on the list. Stay tuned.' }, 201, origin);
    }

    // GET /subscribers (admin only)
    if (request.method === 'GET' && url.pathname === '/subscribers') {
      const secret = request.headers.get('X-Admin-Secret');
      if (!secret || secret !== env.ADMIN_SECRET) {
        return json({ ok: false, error: 'Unauthorized.' }, 401, origin);
      }

      const list = await env.TUMIX_EMAILS.list({ prefix: 'index:' });
      const subscribers = list.keys.map(k => {
        const raw    = k.name.replace(/^index:/, '');
        const isoEnd = raw.lastIndexOf(':');
        return {
          subscribedAt: raw.substring(0, isoEnd),
          email:        raw.substring(isoEnd + 1),
        };
      });

      return json({ ok: true, count: subscribers.length, subscribers }, 200, origin);
    }

    return json({ ok: false, error: 'Not found.' }, 404, origin);
  },
};