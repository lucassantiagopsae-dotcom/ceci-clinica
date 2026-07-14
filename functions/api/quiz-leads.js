// GET /api/quiz-leads?key=...&days=30&limit=100
//
// Returns runs of the qualification form joined to their originating session
// so each row carries its UTMs / fbclid / gclid. This is the view the clinic
// team uses to triage leads before reaching out — who's qualified, their
// answers, and what contact to call.
//
// Source: quiz_responses LEFT JOIN sessions via session_id. Unlike /api/leads
// there's no bot column here — quiz_responses only gets a row when a human
// finishes the form.

export async function onRequestGet(context) {
  const { request, env } = context;

  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!env.DASH_KEY || key !== env.DASH_KEY) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const days = clampInt(url.searchParams.get('days'), 30, 1, 365);
  const limit = clampInt(url.searchParams.get('limit'), 100, 1, 500);
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  try {
    const rows = await env.DB.prepare(`
      SELECT
        q.created_at,
        q.session_id,
        q.raw_email,
        q.raw_name,
        q.raw_phone,
        q.qualified,
        q.answers_json,
        q.event_source_url,
        s.utm_source,
        s.utm_medium,
        s.utm_campaign,
        s.utm_content,
        s.utm_term,
        s.fbclid,
        s.gclid,
        s.referrer,
        s.landing_url
      FROM quiz_responses q
      LEFT JOIN sessions s ON q.session_id = s.session_id
      WHERE q.created_at >= ?
      ORDER BY q.created_at DESC
      LIMIT ?
    `).bind(since, limit).all();

    // Counts grouped by utm_source (qualified vs total) for the summary card.
    const bySource = await env.DB.prepare(`
      SELECT
        COALESCE(NULLIF(s.utm_source, ''), '(direct)') as utm_source,
        COUNT(*) as count,
        SUM(q.qualified) as qualified
      FROM quiz_responses q
      LEFT JOIN sessions s ON q.session_id = s.session_id
      WHERE q.created_at >= ?
      GROUP BY utm_source
      ORDER BY count DESC
    `).bind(since).all();

    const leads = rows.results || [];
    const qualifiedCount = leads.reduce((n, l) => n + (l.qualified ? 1 : 0), 0);

    return json({
      days,
      total: leads.length,
      qualified: qualifiedCount,
      leads,
      summary_by_source: bySource.results || [],
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function clampInt(raw, fallback, min, max) {
  const n = parseInt(raw || '', 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
