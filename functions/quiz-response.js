// POST /quiz-response
//
// Persists one row per finished/declined run of the qualification form.
// Reads the _ceci_sid cookie to link the row to its originating visit (so it
// can be joined back to `sessions` for UTMs), writes with a parameterized
// statement, returns { ok: true }. Conversion events (Lead etc.) are a
// separate path — they go through /tracker.
//
// Expected JSON body:
//   {
//     "first_name": "Maria",
//     "email": "maria@example.com",
//     "phone": "(11) 99999-9999",            // optional
//     "answers": {...},                      // raw {key: value} snapshot (kept as JSON)
//     "answers_labeled": [{ question, key, value, label }, ...],  // human-readable, for Kommo
//     "qualified": true,
//     "event_source_url": "https://.../"
//   }
//
// The generic table stores the full answers in answers_json. If the form has
// a decisive question worth filtering/GROUP BY in SQL, add a denormalized
// column for it in a new migration and bind it here — see docs/QUIZ-PATTERNS.md.
// Raw email/name/phone persist here for analysis only and never leave this
// infra — same convention as event_log.raw_email.

export async function onRequestPost(context) {
  const { request, env } = context;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  try {
    const body = await request.json();
    const cookies = parseCookies(request.headers.get('Cookie') || '');
    const sessionId = cookies['_ceci_sid'] || '';

    const answers = body.answers ?? [];
    const answersLabeled = Array.isArray(body.answers_labeled) ? body.answers_labeled : [];
    const qualified = body.qualified ? 1 : 0;
    const now = Math.floor(Date.now() / 1000);

    if (env.DB) {
      await env.DB.prepare(`
        INSERT INTO quiz_responses (
          session_id, raw_email, raw_name, raw_phone,
          qualified, answers_json, event_source_url, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        sessionId,
        body.email || '',
        body.first_name || '',
        body.phone || '',
        qualified,
        JSON.stringify(answers),
        body.event_source_url || '',
        now
      ).run();
    }

    // Kommo CRM (background, non-blocking) — cria contato + lead + nota com
    // todas as respostas no Funil Odonto. Uma falha aqui não afeta a resposta
    // ao usuário nem a persistência no D1, que já aconteceu acima.
    context.waitUntil(
      sendToKommo({
        env,
        sessionId,
        firstName: body.first_name || '',
        email: body.email || '',
        phone: body.phone || '',
        answersLabeled,
        sourceUrl: body.event_source_url || '',
      }).catch(e => console.error('Kommo error:', e.message))
    );

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

// -----------------------------------------------------------------------------
// KOMMO CRM
//
// IDs abaixo são específicos da conta ceci1.kommo.com (Funil Odonto),
// levantados via GET /api/v4/leads/pipelines e /custom_fields. Se o cliente
// reestruturar pipeline/campos no Kommo, atualize aqui — não são segredo,
// só o subdomínio e o token vêm de env (KOMMO_SUBDOMAIN / KOMMO_TOKEN).
// -----------------------------------------------------------------------------

const KOMMO_PIPELINE_ID = 13903640; // Funil Odonto
// "Incoming leads" (107286296) é o status especial de "não classificado" do
// Kommo — criar um lead direto nele via /leads/complex faz a API cair num
// fallback e jogar o lead no pipeline errado (confirmado por teste). Usar a
// primeira etapa "de verdade" do funil em vez disso.
const KOMMO_STATUS_ID = 107286300;  // Contatado

const KOMMO_FIELDS = {
  regiao: 896685,      // lead: "Em qual região o lead mora:"
  tratamento: 859438,  // lead: "Tratamento"
  urgencia: 859440,    // lead: "Urgência"
  utmSource: 223502,
  utmMedium: 223498,
  utmCampaign: 223500,
  utmContent: 223496,
  utmTerm: 223504,
  fbclid: 223514,
  gclid: 223512,
  referrer: 223508,
  sourceUrl: 885574,   // lead: "Source_url"
  phone: 223488,       // contact: "Telefone"
  phoneEnumMobile: 182720,
  email: 223490,       // contact: "O email"
  emailEnumWork: 182728,
};

async function sendToKommo({ env, sessionId, firstName, email, phone, answersLabeled, sourceUrl }) {
  if (!env.KOMMO_SUBDOMAIN || !env.KOMMO_TOKEN) {
    return { skipped: 'missing kommo env', payload: null, response: null };
  }

  // Atribuição da sessão (UTMs/fbclid/gclid) — mesma linha que o middleware
  // já grava em toda visita, aqui só lida para anexar ao lead.
  let sessionData = {};
  if (sessionId && env.DB) {
    try {
      const row = await env.DB.prepare(
        'SELECT * FROM sessions WHERE session_id = ?'
      ).bind(sessionId).first();
      if (row) sessionData = row;
    } catch (e) {
      console.error('Kommo: D1 session lookup error:', e.message);
    }
  }

  const labelFor = key => answersLabeled.find(a => a.key === key)?.label || '';
  const noteLines = answersLabeled
    .map(a => `- ${a.question} → ${a.label}`)
    .join('\n');

  const leadFields = [];
  const pushField = (fieldId, value) => {
    if (value) leadFields.push({ field_id: fieldId, values: [{ value: String(value) }] });
  };
  pushField(KOMMO_FIELDS.regiao, labelFor('regiao'));
  pushField(KOMMO_FIELDS.tratamento, labelFor('tratamento'));
  pushField(KOMMO_FIELDS.urgencia, labelFor('urgencia'));
  pushField(KOMMO_FIELDS.utmSource, sessionData.utm_source);
  pushField(KOMMO_FIELDS.utmMedium, sessionData.utm_medium);
  pushField(KOMMO_FIELDS.utmCampaign, sessionData.utm_campaign);
  pushField(KOMMO_FIELDS.utmContent, sessionData.utm_content);
  pushField(KOMMO_FIELDS.utmTerm, sessionData.utm_term);
  pushField(KOMMO_FIELDS.fbclid, sessionData.fbclid);
  pushField(KOMMO_FIELDS.gclid, sessionData.gclid);
  pushField(KOMMO_FIELDS.referrer, sessionData.referrer);
  pushField(KOMMO_FIELDS.sourceUrl, sourceUrl);

  const contactFields = [];
  if (phone) contactFields.push({ field_id: KOMMO_FIELDS.phone, values: [{ value: phone, enum_id: KOMMO_FIELDS.phoneEnumMobile }] });
  if (email) contactFields.push({ field_id: KOMMO_FIELDS.email, values: [{ value: email, enum_id: KOMMO_FIELDS.emailEnumWork }] });

  // /leads/complex cria lead + contato + nota em uma única chamada atômica —
  // evita round-trips extras e o risco de criar um sem o outro.
  const payload = [{
    name: `Lead do Typeform${firstName ? ' - ' + firstName : ''}`,
    pipeline_id: KOMMO_PIPELINE_ID,
    status_id: KOMMO_STATUS_ID,
    custom_fields_values: leadFields,
    _embedded: {
      contacts: [{
        first_name: firstName || '',
        custom_fields_values: contactFields,
      }],
      notes: noteLines ? [{
        note_type: 'common',
        params: { text: `Respostas do formulário:\n${noteLines}` },
      }] : [],
    },
  }];

  const payloadJson = JSON.stringify(payload);
  const response = await fetch(`https://${env.KOMMO_SUBDOMAIN}/api/v4/leads/complex`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.KOMMO_TOKEN}`,
    },
    body: payloadJson,
  });
  return { payload: payloadJson, response };
}

function parseCookies(cookieHeader) {
  const cookies = {};
  cookieHeader.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.trim().split('=');
    if (name) cookies[name.trim()] = rest.join('=');
  });
  return cookies;
}
