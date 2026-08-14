// POST /api/crm-event
//
// Recebe do n8n um evento de mudança de etapa do Kommo (QualifiedLead ou
// Purchase) para leads SEM ctwa_clid — Typeform e formulário nativo da Meta.
// Leads de WhatsApp (com ctwa_clid) não passam por aqui: vão direto pro
// whatsapp-tracker-ceci-*/api/fire-qualified-lead|fire-purchase, que já tem o
// pixel de WhatsApp e o carimbo de "já enviei" próprios (ver docs/QUIZ-PATTERNS.md
// e o plano em memória do projeto).
//
// Body: { funnel, kommo_lead_id, event, email, phone, name, value, currency }
// Auth: header `x-crm-token` (ou ?token=) == env.CRM_EVENT_SECRET
//
// Resolução de identidade: kommo_lead_id é usado pra achar a sessão do
// Typeform (quiz_responses → sessions), o que traz fbc/fbp/external_id/ip/ua —
// o join mais forte dos três caminhos, porque o número do card é escrito por
// nós mesmos, não é telefone (ver KOMMO-INTEGRATION-NOTES.md,
// persistKommoStatus() em quiz-response.js). Se não achar linha correspondente,
// o lead é tratado como "form nativo": envia só email/telefone hasheados.

import { sha256, normalizePhone, normalizeName } from '../lib/hash.js';

const VALID_EVENTS = new Set(['QualifiedLead', 'Purchase']);
const VALID_FUNNELS = new Set(['odonto', 'estetica']);

const FUNNEL_ENV = {
  odonto: { pixelKey: 'META_PIXEL_ID', tokenKey: 'META_ACCESS_TOKEN' },
  estetica: { pixelKey: 'META_PIXEL_ID_ESTETICA', tokenKey: 'META_ACCESS_TOKEN_ESTETICA' },
};

export async function onRequestPost({ request, env }) {
  const auth = checkAuth(request, env);
  if (auth) return auth;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const funnel = String(body?.funnel || '');
  const kommoLeadId = body?.kommo_lead_id != null ? String(body.kommo_lead_id) : '';
  const eventName = String(body?.event || '');
  const value = body?.value != null ? Number(body.value) : null;
  const currency = body?.currency ? String(body.currency).toUpperCase() : (env.DEFAULT_CURRENCY || 'BRL');

  if (!VALID_FUNNELS.has(funnel)) return json({ error: 'invalid_funnel' }, 400);
  if (!kommoLeadId) return json({ error: 'missing_kommo_lead_id' }, 400);
  if (!VALID_EVENTS.has(eventName)) return json({ error: 'invalid_event' }, 400);

  // Meta rejeita Purchase sem value — confirmado, não é "otimiza pior sem
  // valor", o evento inteiro é recusado. Não vale a pena nem tentar: registra
  // como pendência e sai. Ver a decisão em docs/TRACKING-ROADMAP.md.
  if (eventName === 'Purchase' && (!Number.isFinite(value) || value <= 0)) {
    await logCrmEvent(env, {
      kommoLeadId, funnel, eventName, matched: 'n/a', status: 'no_value',
      value: null, currency, attempts: 0, metaResponse: null, error: 'missing or zero value',
    });
    return json({ error: 'missing_value' }, 422);
  }

  // Trava de duplicata — checa ANTES de gastar uma chamada à Meta.
  const already = env.DB
    ? await env.DB.prepare(
        'SELECT status FROM crm_events WHERE kommo_lead_id = ? AND event_name = ?'
      ).bind(kommoLeadId, eventName).first()
    : null;
  if (already && already.status === 'sent') {
    return json({ error: 'already_sent' }, 409);
  }

  // --- Resolução de identidade: tenta achar a sessão do Typeform ---
  let sessionRow = null;
  let matched = 'none';
  if (env.DB) {
    sessionRow = await env.DB.prepare(`
      SELECT s.fbc, s.fbp, s.external_id, s.ip_address, s.user_agent,
             q.raw_email, q.raw_phone, q.raw_name, q.event_source_url
      FROM quiz_responses q
      JOIN sessions s ON s.session_id = q.session_id
      WHERE q.kommo_lead_id = ?
      ORDER BY q.created_at DESC
      LIMIT 1
    `).bind(kommoLeadId).first();
    if (sessionRow) matched = 'typeform';
  }

  const email = sessionRow?.raw_email || body?.email || '';
  const phone = sessionRow?.raw_phone || body?.phone || '';
  const name = sessionRow?.raw_name || body?.name || '';

  // --- Credenciais do pixel do funil ---
  const { pixelKey, tokenKey } = FUNNEL_ENV[funnel];
  const pixelId = env[pixelKey];
  const accessToken = env[tokenKey];
  if (!pixelId || !accessToken) {
    await logCrmEvent(env, {
      kommoLeadId, funnel, eventName, matched, status: 'skipped_no_creds',
      value, currency, attempts: 0, metaResponse: null, error: `missing ${pixelKey}/${tokenKey}`,
    });
    return json({ ok: false, matched, status: 'skipped_no_creds' }, 200);
  }

  // --- Monta e envia o evento CAPI ---
  const hashedEm = await sha256(email);
  const hashedPh = await sha256(normalizePhone(phone, env.DEFAULT_COUNTRY_CODE));
  const hashedFn = await sha256(normalizeName(firstName(name)));
  const hashedExternalId = sessionRow?.external_id ? await sha256(sessionRow.external_id) : '';

  const userData = {};
  if (hashedEm) userData.em = [hashedEm];
  if (hashedPh) userData.ph = [hashedPh];
  if (hashedFn) userData.fn = [hashedFn];
  if (hashedExternalId) userData.external_id = [hashedExternalId];
  if (sessionRow?.fbc) userData.fbc = sessionRow.fbc;
  if (sessionRow?.fbp) userData.fbp = sessionRow.fbp;
  if (sessionRow?.ip_address) userData.client_ip_address = sessionRow.ip_address;
  if (sessionRow?.user_agent) userData.client_user_agent = sessionRow.user_agent;

  // event_id fixo por lead+evento — dedup adicional do lado da Meta (48h),
  // além da trava permanente que já fizemos acima via crm_events.
  const eventId = `${kommoLeadId}:${eventName.toLowerCase()}`;

  const payload = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      event_source_url: sessionRow?.event_source_url || undefined,
      action_source: 'website',
      user_data: userData,
      ...(eventName === 'Purchase' ? { custom_data: { value, currency } } : {}),
    }],
  };
  if (env.META_TEST_EVENT_CODE) payload.test_event_code = env.META_TEST_EVENT_CODE;

  const { res, attempts } = await fetchWithRetry(
    `https://graph.facebook.com/v25.0/${pixelId}/events?access_token=${accessToken}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
  );
  const responseText = await res.text().catch(() => '');
  const ok = res.ok;

  await logCrmEvent(env, {
    kommoLeadId, funnel, eventName, matched,
    status: ok ? 'sent' : 'failed',
    eventId, value: eventName === 'Purchase' ? value : null, currency,
    attempts, metaResponse: responseText, error: ok ? null : responseText.slice(0, 500),
  });

  return json({ ok, matched, status: ok ? 'sent' : 'failed' }, ok ? 200 : 502);
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-crm-token',
    },
  });
}

function firstName(fullName) {
  if (!fullName) return '';
  return String(fullName).trim().split(/\s+/)[0] || '';
}

function checkAuth(request, env) {
  const token =
    request.headers.get('x-crm-token') ||
    new URL(request.url).searchParams.get('token');
  if (!env.CRM_EVENT_SECRET || !token || token !== env.CRM_EVENT_SECRET) {
    return json({ error: 'unauthorized' }, 401);
  }
  return null;
}

// Mesmo critério de retry usado em functions/quiz-response.js
// (fetchWithRetry): repete só erro de rede ou 5xx; 4xx é rejeição de
// conteúdo e não se resolve tentando de novo.
async function fetchWithRetry(url, options, delaysMs = [500, 1500]) {
  let lastErr = null;
  let lastRes = null;
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok || res.status < 500) return { res, attempts: attempt + 1 };
      lastRes = res;
    } catch (e) {
      lastErr = e;
    }
    if (attempt < delaysMs.length) await new Promise(r => setTimeout(r, delaysMs[attempt]));
  }
  if (lastRes) return { res: lastRes, attempts: delaysMs.length + 1 };
  throw lastErr;
}

async function logCrmEvent(env, { kommoLeadId, funnel, eventName, matched, status, eventId = null, value = null, currency = null, attempts = 0, metaResponse = null, error = null }) {
  if (!env.DB) return;
  try {
    await env.DB.prepare(`
      INSERT INTO crm_events (kommo_lead_id, funnel, event_name, matched, status, event_id, value, currency, attempts, meta_response, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(kommo_lead_id, event_name) DO UPDATE SET
        status = excluded.status, matched = excluded.matched, event_id = excluded.event_id,
        value = excluded.value, currency = excluded.currency,
        attempts = excluded.attempts, meta_response = excluded.meta_response,
        error = excluded.error, created_at = excluded.created_at
    `).bind(kommoLeadId, funnel, eventName, matched, status, eventId, value, currency, attempts, metaResponse, error, Math.floor(Date.now() / 1000)).run();
  } catch (e) {
    console.error('crm-event: falha ao gravar log', e.message);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
  });
}
