-- Qualification form responses. One row per completed run (or early exit,
-- if the page chooses to persist those too). Written by
-- functions/quiz-response.js. Linked to the originating visit via session_id
-- (the _ceci_sid cookie), so queries can join back to `sessions` for the
-- originating UTMs / fbclid / gclid.
--
-- `answers_json` holds the full answers snapshot. If the form has decisive
-- questions worth filtering/GROUP BY in SQL, add denormalized columns for
-- them in a NEW migration — don't edit this one after it has been applied.
-- Raw PII (email/name/phone) is stored here for analysis only and never
-- leaves this infra, same convention as `event_log.raw_email`.
CREATE TABLE IF NOT EXISTS quiz_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    raw_email TEXT,
    raw_name TEXT,
    raw_phone TEXT,
    qualified INTEGER DEFAULT 0,
    answers_json TEXT,
    event_source_url TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quiz_responses_created ON quiz_responses(created_at);
CREATE INDEX IF NOT EXISTS idx_quiz_responses_session ON quiz_responses(session_id);
CREATE INDEX IF NOT EXISTS idx_quiz_responses_qualified ON quiz_responses(qualified);
