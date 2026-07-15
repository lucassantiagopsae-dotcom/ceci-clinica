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
  // Um único telefone, exatamente o que a pessoa digitou, só normalizado pro
  // formato internacional (+55...). Já salvamos as duas grafias do nono
  // dígito aqui no passado, mas isso confundia o time de vendas (parecia que
  // o contato tinha dois números) e não resolveu a duplicação de card do
  // WhatsApp Lite — que não busca contato por telefone (limitação do Kommo,
  // ver histórico). Etiqueta WORK ("Tel. comercial"), a mesma que a
  // integração de WhatsApp do Kommo usa.
  let phoneIntl = phone;
  if (/^\d{10,11}$/.test(phone)) phoneIntl = `+55${phone}`;
  else if (/^55\d{10,11}$/.test(phone)) phoneIntl = `+${phone}`;

  const contactFields = [];
  if (phone) contactFields.push({ field_id: KOMMO_FIELDS.phone, values: [{ value: phoneIntl, enum_id: KOMMO_FIELDS.phoneEnumWork }] });
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
  // O Kommo rejeita a criação INTEIRA do lead (HTTP 400 TooLong) se qualquer
  // campo de texto passar de 256 caracteres — URL de anúncio com UTMs/fbclid
  // passa disso com folga (caso real: 524 chars, e o lead se perdeu em
  // silêncio). O valor completo continua no D1 e vai na nota do passo 4,
  // que não tem esse limite.
  const kommoText = v => String(v).slice(0, 256);
  const leadFields = [];
  const pushField = (fieldId, value) => {
    if (value) leadFields.push({ field_id: fieldId, values: [{ value: kommoText(value) }] });
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
      // A API valida metadata.ip como não-vazio (400 NotBlank se faltar).
      ip: clientIp || '0.0.0.0',
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
    // Loga o corpo do erro — sem isso a falha é invisível (caso real: 400
    // TooLong derrubou leads de anúncio em silêncio até ser descoberto
    // cruzando o D1 com o Kommo à mão).
    const errBody = await leadRes.text().catch(() => '');
    console.error('Kommo: criação do lead FALHOU', leadRes.status, errBody.slice(0, 500));
    // Contato ficaria órfão (sem lead vinculado, invisível no funil) — desfaz.
    // Atenção: nesta conta o DELETE de contato via API retorna 405 (bloqueado
    // pelo plano/2FA), então o desfazer pode não funcionar — por isso o log
    // acima é o sinal principal pra recuperar o lead pelo D1.
    try {
      const delRes = await fetch(`${kommoBase}/contacts/${contactId}`, { method: 'DELETE', headers: authHeaders });
      if (!delRes.ok) console.error('Kommo: não foi possível desfazer contato órfão', contactId, delRes.status);
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
  // A nota não tem o limite de 256 caracteres dos campos, então a URL de
  // origem e o fbclid vão aqui na íntegra (nos campos vão truncados).
  if (leadId && noteLines) {
    const origemLines = [];
    if (sourceUrl) origemLines.push(`- URL de origem: ${sourceUrl}`);
    if (sessionData.fbclid) origemLines.push(`- fbclid: ${sessionData.fbclid}`);
    const noteText = `Respostas do formulário:\n${noteLines}` +
      (origemLines.length ? `\n\nOrigem (completa):\n${origemLines.join('\n')}` : '');
    try {
      await fetch(`${kommoBase}/leads/${leadId}/notes`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify([{ note_type: 'common', params: { text: noteText } }]),
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
