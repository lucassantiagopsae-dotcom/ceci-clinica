-- Core tracking schema: one row per visit (sessions) and one row per
-- conversion event fired through /tracker (event_log). Everything else
-- (quiz responses, purchases, etc.) gets added later as its own migration
-- once that flow exists.

CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    external_id TEXT NOT NULL,
    fbclid TEXT,
    gclid TEXT,
    msclkid TEXT,
    fbc TEXT,
    fbp TEXT,
    ip_address TEXT,
    user_agent TEXT,
    referrer TEXT,
    landing_url TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    utm_content TEXT,
    utm_term TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS event_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    event_name TEXT NOT NULL,
    event_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    browser TEXT,
    browser_version TEXT,
    os TEXT,
    is_mobile INTEGER DEFAULT 0,
    pixel_was_blocked INTEGER DEFAULT 0,
    fbp_source TEXT,
    fbc_source TEXT,
    fbclid_source TEXT,
    ga_cookie_present INTEGER DEFAULT 0,
    ga_client_id_fallback INTEGER DEFAULT 0,
    itp_cookie_extended INTEGER DEFAULT 0,
    is_bot INTEGER DEFAULT 0,
    bot_reason TEXT,
    consent_status TEXT,
    sent_to_meta INTEGER DEFAULT 0,
    meta_status_code INTEGER DEFAULT 0,
    meta_response_ok INTEGER DEFAULT 0,
    meta_response_body TEXT DEFAULT '',
    meta_payload_sent TEXT,
    sent_to_ga4 INTEGER DEFAULT 0,
    ga4_status_code INTEGER DEFAULT 0,
    ga4_response_ok INTEGER DEFAULT 0,
    ga4_response_body TEXT,
    ga4_payload_sent TEXT,
    has_email INTEGER DEFAULT 0,
    has_phone INTEGER DEFAULT 0,
    has_name INTEGER DEFAULT 0,
    raw_email TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_event_log_timestamp ON event_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_event_log_event_name ON event_log(event_name);
CREATE INDEX IF NOT EXISTS idx_event_log_browser ON event_log(browser);
CREATE INDEX IF NOT EXISTS idx_event_log_session ON event_log(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at);
