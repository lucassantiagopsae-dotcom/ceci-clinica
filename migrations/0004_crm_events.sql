-- Registra eventos de CRM (QualifiedLead / Purchase) disparados por
-- functions/api/crm-event.js quando um card muda de etapa no Kommo, para os
-- leads que NÃO têm ctwa_clid (Typeform + formulário nativo da Meta) — o par
-- WhatsApp desse carimbo é whatsapp-tracker-ceci-*-db.conversions
-- (qualified_lead_status / purchase_status).
--
-- UNIQUE(kommo_lead_id, event_name) é a trava contra duplicata: um card indo
-- e voltando de "Agendado" várias vezes só gera UMA linha 'sent' por evento;
-- tentativas seguintes batem no UNIQUE e retornam already_sent sem reenviar.
--
-- matched: 'typeform' (achou sessão via kommo_lead_id → fbc/fbp/external_id)
--          | 'none'   (form nativo — só email/telefone hasheados)
-- status:  'sent' | 'failed' | 'no_value' (Purchase sem price — Meta rejeita
--          evento de compra sem valor) | 'skipped_no_creds'
CREATE TABLE IF NOT EXISTS crm_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kommo_lead_id TEXT NOT NULL,
    funnel TEXT NOT NULL,
    event_name TEXT NOT NULL,
    matched TEXT NOT NULL,
    status TEXT NOT NULL,
    event_id TEXT,
    value REAL,
    currency TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    meta_response TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(kommo_lead_id, event_name)
);

CREATE INDEX IF NOT EXISTS idx_crm_events_kommo_lead ON crm_events(kommo_lead_id);
CREATE INDEX IF NOT EXISTS idx_crm_events_status ON crm_events(status);
