-- Registra o resultado do envio pro Kommo (functions/quiz-response.js /
-- sendToKommo) direto na linha do formulário, em vez de só nos logs efêmeros
-- da Cloudflare. Sem isso, leads que falham na criação do card (rede
-- instável, erro do Kommo) só eram descobertos cruzando D1 x Kommo à mão
-- (foi assim que Sara, Gabriel e Celia foram achados em 15-16/07/2026).
--
-- kommo_status: 'ok' | 'failed' | 'skipped' (env do Kommo não configurado) | NULL (ainda não processado / DB indisponível)
-- kommo_error: motivo da falha, quando kommo_status = 'failed'
ALTER TABLE quiz_responses ADD COLUMN kommo_status TEXT;
ALTER TABLE quiz_responses ADD COLUMN kommo_lead_id TEXT;
ALTER TABLE quiz_responses ADD COLUMN kommo_contact_id TEXT;
ALTER TABLE quiz_responses ADD COLUMN kommo_error TEXT;

CREATE INDEX IF NOT EXISTS idx_quiz_responses_kommo_status ON quiz_responses(kommo_status);
