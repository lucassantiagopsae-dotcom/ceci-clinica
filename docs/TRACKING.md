# Tracking

Este projeto usa um stack de rastreamento server-side para Cloudflare Pages com **Meta Conversions API (CAPI)**. Roda como parte do *mesmo* projeto Cloudflare Pages que serve as páginas — isso é obrigatório, os cookies first-party e o middleware de borda só funcionam same-origin com as landing pages.

Faz duas coisas:

1. **Eventos de conversão server-side** para o Meta CAPI, deduplicados contra o pixel do browser pelo `event_id`, com PII (e-mail/nome/telefone) hasheada em SHA-256 para Advanced Matching. Sobrevive a ad blockers e ao Safari ITP porque os identificadores (`_fbp`, `_fbc`, `_ceci_sid`, `_ceci_eid`) são cookies first-party de 400 dias, setados na borda.
2. **Persistência de atribuição first-party** — todo acesso grava `fbclid`/`gclid`/UTMs numa linha de `sessions` no D1, para que leads (e as respostas do formulário) possam ser ligados de volta à campanha/anúncio de origem.

GA4 é **opcional** — só ativa se `GA4_MEASUREMENT_ID`/`GA4_API_SECRET` estiverem configurados; sem eles, só o Meta recebe eventos.

Não há checkout nem webhook de pagamento neste projeto (ver nota abaixo) — é um funil de captação de leads via formulário.

## O fluxo, passo a passo

```
visitante acessa /landing-page?utm_source=facebook&fbclid=...
  → functions/_middleware.js
       seta cookies _ceci_sid / _fbp / _fbc / _ceci_eid (400 dias)
       captura fbclid/gclid/utm_* → UPSERT na linha de sessions
  → <head> da página: Meta Pixel init + PageView (pixel + CAPI via /tracker;
       PageView é disparado ao Meta mas não é gravado em event_log)
  → visitante preenche o formulário / responde o quiz
       → fbq('track', 'Lead', {}, { eventID })              (pixel, browser)
       → POST /tracker  { event_name: 'Lead', event_id: eventID, user_data: { em, fn } }
            functions/tracker.js: hasheia em/fn/ph em SHA-256, enriquece
            fbp/fbc/external_id a partir da linha de sessions, dispara o
            Meta CAPI, grava uma linha em event_log
```

Quando o formulário/quiz específico do cliente for desenhado, siga `docs/QUIZ-PATTERNS.md` para adicionar a persistência das respostas (`POST /quiz-response` + migration nova) e, se fizer sentido, eventos customizados de qualificação (`LeadQualificado` etc.).

## Environment variables (Cloudflare Pages → Settings → Environment variables → Production)

Required:

| Name | Value | Encrypt? |
|---|---|---|
| `META_PIXEL_ID` | ID numérico do Pixel — mesmo valor do `fbq('init', ...)` da página | não |
| `META_ACCESS_TOKEN` | Token CAPI de longa duração (Events Manager → seu Pixel → Settings → Generate access token) | sim |
| `DASH_KEY` | string aleatória (`openssl rand -hex 32`) — protege `/api/*` | sim |

Optional: `GA4_MEASUREMENT_ID` + `GA4_API_SECRET` (liga o GA4), `META_TEST_EVENT_CODE` (roteia eventos para Events Manager → Test Events), `DEFAULT_COUNTRY_CODE` (padrão `55`, usado para normalizar telefone antes de hashear).

Required binding: um banco **D1 vinculado com nome de variável `DB`** (o código lê `env.DB`).

## Deploy / setup do D1

**Windows:** antes de qualquer comando `wrangler`, dot-source o arquivo de credenciais na sessão do PowerShell:

```powershell
$env:WRANGLER_SEND_METRICS = "false"
. .\cloudflare-minha-conta.ps1     # arquivo com CLOUDFLARE_API_TOKEN e CLOUDFLARE_ACCOUNT_ID (gitignored — ver README)
```

```powershell
npx --yes wrangler@latest d1 create typeform-ceci-db     # anote o database_id que ele imprime
# cole o database_id em wrangler.toml (já criado neste projeto com placeholder)
npx --yes wrangler@latest d1 migrations apply typeform-ceci-db --remote
```

Depois, no painel da Cloudflare (Pages → este projeto):
- **Settings → Bindings → Add → D1 database**: variable name `DB`, database `typeform-ceci-db`.
- **Settings → Environment variables**: adicione a tabela acima.
- **Deployments → último deploy → Retry deployment** (mudanças de env var/binding não se aplicam a deploys já existentes).

## Verificando que está funcionando

Depois de um deploy, acesse `https://<seu-domínio>/landing-page/?utm_source=test&utm_medium=verify`, confira que os cookies `_ceci_sid` e `_fbp` foram setados (DevTools → Application → Cookies), preencha o formulário com um e-mail descartável, então:

```bash
npx wrangler@latest d1 execute typeform-ceci-db --remote --command \
  "SELECT event_name, raw_email, meta_response_ok, meta_response_body FROM event_log ORDER BY id DESC LIMIT 5"

npx wrangler@latest d1 execute typeform-ceci-db --remote --command \
  "SELECT session_id, utm_source, utm_campaign, fbp, created_at FROM sessions ORDER BY created_at DESC LIMIT 5"
```

`meta_response_ok = 1` significa que o Meta aceitou o evento CAPI. Se for `0`, `meta_response_body` traz o motivo (geralmente `META_ACCESS_TOKEN` errado/expirado ou `META_PIXEL_ID` errado). Confirme também no Meta Events Manager → seu Pixel → Test Events (se `META_TEST_EVENT_CODE` estiver setado) ou na aba Overview.

## Nota sobre pagamentos/checkout

Este projeto não tem checkout nem webhook de pagamento (ex: Hotmart) — é um funil de captação via formulário. Se um fluxo de venda for adicionado no futuro (checkout próprio, Hotmart, Kiwify etc.), isso exige um pipeline separado (`checkout_sessions` → webhook → `purchase_log`) que não está incluído nesta base; peça para eu montar quando o fluxo de venda estiver definido.
