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
    // todas as respostas no Funil Odonto (Incoming leads). Uma falha aqui não
    // afeta a resposta ao usuário nem a persistência no D1, que já aconteceu
    // acima.
    context.waitUntil(
      sendToKommo({
        env,
        sessionId,
        firstName: body.first_name || '',
        email: body.email || '',
        phone: body.phone || '',
        answersLabeled,
        sourceUrl: body.event_source_url || '',
        clientIp: request.headers.get('cf-connecting-ip') || '',
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
// Kommo — criar um lead direto nele via /leads/complex (endpoint genérico)
// faz a API cair num fallback e jogar o lead no pipeline errado (confirmado
// por teste). O endpoint certo pra esse status é /leads/unsorted/forms
// (feito especificamente pra leads vindos de formulário), usado abaixo.

const KOMMO_FIELDS = {
  regiao: 896685,      // lead: "Em qual região o lead mora:"
  tratamento: 859438,  // lead: "Tratamento"
  urgencia: 859440,    // lead: "Urgência"
  airflow: 899703,     // lead: "Conhece o AIRFLOW?"
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
  // WORK ("Tel. comercial"), não MOB: é a etiqueta que a integração de
  // WhatsApp do Kommo usa ao salvar o número de quem manda mensagem. Teste
  // real mostrou que valor idêntico com etiqueta MOB não casou a conversa.
  phoneEnumWork: 182716,
  email: 223490,       // contact: "O email"
  emailEnumWork: 182728,
};

// Quatro chamadas em sequência (confirmado por teste — é o único jeito de um
// lead novo nascer em "Incoming leads" de verdade, com contato de fato ligado):
//   1. cria o contato (telefone/e-mail)
//   2. cria o lead via /leads/unsorted/forms
//   3. vincula o contato ao lead via /leads/{id}/link
//   4. anexa a nota com todas as respostas
// Se o passo 2 falhar depois do 1 ter dado certo, o contato fica órfão (sem
// lead vinculado — invisível no funil); por isso desfazemos ele nesse caso.
// Se só o passo 3 falhar, o lead já existe normalmente no funil — só falta
// a nota, o que é registrado no log mas não é crítico.
async function sendToKommo({ env, sessionId, firstName, email, phone, answersLabeled, sourceUrl, clientIp }) {
  if (!env.KOMMO_SUBDOMAIN || !env.KOMMO_TOKEN) {
    return { skipped: 'missing kommo env' };
  }

  const kommoBase = `https://${env.KOMMO_SUBDOMAIN}/api/v4`;
  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${env.KOMMO_TOKEN}`,
  };

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

  // --- 1) Contato ---
  // O unibox do Kommo casa mensagens de WhatsApp com o contato pelo telefone,
  // e o WhatsApp entrega o remetente no formato internacional (+5511...).
  // Detalhe traiçoeiro: WhatsApps registrados antes do nono dígito chegam SEM
  // o 9 (+554299772372 em vez de +5542999772372) — confirmado em teste real,
  // onde isso duplicou o lead. Por isso salvamos as duas grafias no contato:
  // o unibox casa a conversa em qualquer uma delas.
  const phoneValues = [];
  let phoneDigits = phone;
  if (/^55\d{10,11}$/.test(phoneDigits)) phoneDigits = phoneDigits.slice(2);
  if (/^\d{10,11}$/.test(phoneDigits)) {
    const ddd = phoneDigits.slice(0, 2);
    const local = phoneDigits.slice(2);
    if (local.length === 9 && local.startsWith('9')) {
      phoneValues.push(`+55${ddd}${local}`, `+55${ddd}${local.slice(1)}`);
    } else if (local.length === 8) {
      phoneValues.push(`+55${ddd}9${local}`, `+55${ddd}${local}`);
    } else {
      phoneValues.push(`+55${ddd}${local}`);
    }
  } else if (phone) {
    phoneValues.push(phone);
  }

  const contactFields = [];
  if (phoneValues.length) contactFields.push({ field_id: KOMMO_FIELDS.phone, values: phoneValues.map(v => ({ value: v, enum_id: KOMMO_FIELDS.phoneEnumWork })) });
  if (email) contactFields.push({ field_id: KOMMO_FIELDS.email, values: [{ value: email, enum_id: KOMMO_FIELDS.emailEnumWork }] });

  const contactRes = await fetch(`${kommoBase}/contacts`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify([{ first_name: firstName || '', custom_fields_values: contactFields }]),
  });
  if (!contactRes.ok) {
    return { skipped: `contact creation failed: HTTP ${contactRes.status}`, response: contactRes };
  }
  const contactData = await contactRes.json();
  const contactId = contactData?._embedded?.contacts?.[0]?.id;
  if (!contactId) {
    return { skipped: 'contact creation returned no id' };
  }

  // --- 2) Lead em "Incoming leads" (endpoint específico pra leads de formulário) ---
  const leadFields = [];
  const pushField = (fieldId, value) => {
    if (value) leadFields.push({ field_id: fieldId, values: [{ value: String(value) }] });
  };
  pushField(KOMMO_FIELDS.regiao, labelFor('regiao'));
  pushField(KOMMO_FIELDS.tratamento, labelFor('tratamento'));
  pushField(KOMMO_FIELDS.urgencia, labelFor('urgencia'));
  pushField(KOMMO_FIELDS.airflow, labelFor('airflow'));
  pushField(KOMMO_FIELDS.utmSource, sessionData.utm_source);
  pushField(KOMMO_FIELDS.utmMedium, sessionData.utm_medium);
  pushField(KOMMO_FIELDS.utmCampaign, sessionData.utm_campaign);
  pushField(KOMMO_FIELDS.utmContent, sessionData.utm_content);
  pushField(KOMMO_FIELDS.utmTerm, sessionData.utm_term);
  pushField(KOMMO_FIELDS.fbclid, sessionData.fbclid);
  pushField(KOMMO_FIELDS.gclid, sessionData.gclid);
  pushField(KOMMO_FIELDS.referrer, sessionData.referrer);
  pushField(KOMMO_FIELDS.sourceUrl, sourceUrl);

  const now = Math.floor(Date.now() / 1000);
  const unsortedPayload = [{
    source_name: 'Typeform CECI',
    source_uid: `typeform-ceci-${crypto.randomUUID()}`,
    pipeline_id: KOMMO_PIPELINE_ID,
    created_at: now,
    metadata: {
      form_id: 'typeform-ceci',
      form_name: 'Typeform CECI - Avaliação',
      form_page: sourceUrl || '',
      form_sent_at: now,
      ip: clientIp || '',
    },
    _embedded: {
      leads: [{
        // Só o nome da pessoa: automações que puxam o primeiro nome do lead
        // não podem receber "Lead". A origem fica na tag "Typeform Odonto".
        name: firstName || 'Sem nome (Typeform)',
        custom_fields_values: leadFields,
        _embedded: { tags: [{ name: 'Typeform Odonto' }] },
        // Sem contato embutido aqui de propósito: o endpoint ignora o id e
        // grava uma referência fantasma ("contato 1", inexistente). O vínculo
        // real é feito no passo 3 via /leads/{id}/link.
      }],
    },
  }];

  const payloadJson = JSON.stringify(unsortedPayload);
  const leadRes = await fetch(`${kommoBase}/leads/unsorted/forms`, {
    method: 'POST',
    headers: authHeaders,
    body: payloadJson,
  });

  if (!leadRes.ok) {
    // Contato ficaria órfão (sem lead vinculado, invisível no funil) — desfaz.
    try {
      await fetch(`${kommoBase}/contacts/${contactId}`, { method: 'DELETE', headers: authHeaders });
    } catch (e) {
      console.error('Kommo: falha ao desfazer contato órfão', contactId, e.message);
    }
    return { skipped: `lead creation failed: HTTP ${leadRes.status}`, payload: payloadJson, response: leadRes };
  }

  const leadData = await leadRes.json();
  const leadId = leadData?._embedded?.unsorted?.[0]?._embedded?.leads?.[0]?.id;

  // --- 3) Vínculo explícito contato ↔ lead ---
  // A referência embutida no payload acima não vincula de verdade (o card
  // aparece com um contato fantasma "id 1" — confirmado por teste). O link
  // explícito é o que faz o telefone aparecer no card e permite ao unibox
  // centralizar a conversa de WhatsApp nele em vez de duplicar o lead.
  if (leadId) {
    try {
      const linkRes = await fetch(`${kommoBase}/leads/${leadId}/link`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify([{ to_entity_id: contactId, to_entity_type: 'contacts' }]),
      });
      if (!linkRes.ok) console.error('Kommo: falha ao vincular contato ao lead', leadId, contactId, linkRes.status);
    } catch (e) {
      console.error('Kommo: erro ao vincular contato ao lead', leadId, contactId, e.message);
    }
  }

  // --- 4) Nota com as respostas completas ---
  if (leadId && noteLines) {
    try {
      await fetch(`${kommoBase}/leads/${leadId}/notes`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify([{ note_type: 'common', params: { text: `Respostas do formulário:\n${noteLines}` } }]),
      });
    } catch (e) {
      console.error('Kommo: falha ao anexar nota (lead já existe, não é crítico)', leadId, e.message);
    }
  }

  return { leadId, contactId, payload: payloadJson, response: leadRes };
}

function parseCookies(cookieHeader) {
  const cookies = {};
  cookieHeader.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.trim().split('=');
    if (name) cookies[name.trim()] = rest.join('=');
  });
  return cookies;
}
