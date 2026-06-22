/**
 * Tu-mix Email Capture Worker
 * Stores subscriber emails in Cloudflare KV.
 * Deploy with: wrangler deploy
 */

const ALLOWED_ORIGIN = 'https://tu-mix.com';

// ── CORS headers ──────────────────────────────────────────
function corsHeaders(origin) {
  const allowed = origin === ALLOWED_ORIGIN || origin === 'https://www.tu-mix.com';
  return {
    'Access-Control-Allow-Origin':  allowed ? origin : ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}

function json(data, status = 200, origin = ALLOWED_ORIGIN) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

// ── Email validation ──────────────────────────────────────
function isValidEmail(email) {
  return typeof email === 'string'
    && email.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim().toLowerCase());
}

// ── Main handler ──────────────────────────────────────────
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || ALLOWED_ORIGIN;
    const url    = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // ── POST /subscribe ──
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

      // Check for duplicate
      const existing = await env.TUMIX_EMAILS.get(`email:${email}`);
      if (existing) {
        // Silently succeed — don't reveal whether email is already registered
        return json({ ok: true, message: 'You are on the list.' }, 200, origin);
      }

      const subscribedAt = new Date().toISOString();

      // Store individual record  key: email:<address>  value: ISO timestamp
      await env.TUMIX_EMAILS.put(`email:${email}`, subscribedAt);

      // Maintain a running index list (key: index:<timestamp>:<email>)
      // This lets you list all subscribers in order via KV list()
      await env.TUMIX_EMAILS.put(`index:${subscribedAt}:${email}`, email);

      console.log(`New subscriber: ${email} at ${subscribedAt}`);

      return json({ ok: true, message: 'You are on the list. Stay tuned.' }, 201, origin);
    }

    // ── GET /subscribers (admin export, requires secret header) ──
    if (request.method === 'GET' && url.pathname === '/subscribers') {
      const secret = request.headers.get('X-Admin-Secret');
      if (!secret || secret !== env.ADMIN_SECRET) {
        return json({ ok: false, error: 'Unauthorized.' }, 401, origin);
      }

      const list   = await env.TUMIX_EMAILS.list({ prefix: 'index:' });
      const emails = list.keys.map(k => {
        // key format: index:<timestamp>:<email>
        const parts = k.name.split(':');
        return { email: parts[2], subscribedAt: `${parts[0] === 'index' ? parts[1] : ''}` };
      });

      // Re-shape: index:2026-06-22T10:00:00.000Z:foo@bar.com
      const subscribers = list.keys.map(k => {
        const raw   = k.name.replace(/^index:/, '');          // 2026-06-22T...:foo@bar.com
        const split = raw.indexOf(':');                        // find second colon after timestamp
        // ISO timestamps contain colons — find the email after the last segment
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
