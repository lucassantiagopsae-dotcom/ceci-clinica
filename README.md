# Clínica CECI — Link na bio

Página "link na bio" própria da Clínica CECI (estética facial · Penha, São Paulo).
Substitui o Linktree por uma estrutura própria, hospedável e sob controle da marca.

Site estático, sem build e sem dependências — pronto para hospedar em qualquer lugar.

## Estrutura

```
.
├── index.html      # A página (HTML + CSS inline)
├── assets/
│   └── logo.webp   # Logo da clínica (avatar + favicon)
├── .nojekyll       # Faz o GitHub Pages servir os arquivos sem processar Jekyll
├── README.md
└── .gitignore
```

## Rodar localmente

É um site estático — basta abrir o `index.html` no navegador. Para servir via HTTP:

```bash
npx serve .
# ou
python -m http.server 8000
```

## Publicar no GitHub Pages

1. Suba este repositório para o GitHub (branch `main`).
2. No repositório: **Settings → Pages**.
3. Em **Build and deployment → Source**, escolha **Deploy from a branch**.
4. Selecione a branch `main` e a pasta `/ (root)` e salve.
5. Em ~1 min a página fica no ar em `https://<usuario>.github.io/ceci-clinica/`.

Para domínio próprio (ex.: `links.clinicaceci.com.br`), adicione um arquivo `CNAME`
na raiz com o domínio e configure o DNS conforme a documentação do GitHub Pages.
Outras opções de host estático: Netlify, Vercel, Cloudflare Pages (todas sem build).

## Links configurados

| # | Item | Destino |
|---|------|---------|
| — | Instagram (ícone) | https://www.instagram.com/ceci.clinica/ |
| — | WhatsApp (ícone) | +55 11 99938-0130 — mensagem de dúvidas |
| — | TikTok (ícone) | https://www.tiktok.com/@clinica.ceci |
| 1 | Agende sua consulta (botão) | WhatsApp +55 11 99938-0130 — mensagem de agendamento |
| 2 | Como chegar (botão) | Google Maps — R. Jorge Augusto, 221, Vila Centenário, SP |

Para trocar número, mensagens ou endereço, edite os `href` correspondentes em `index.html`.

## Paleta da marca

| Token | Hex | Uso |
|-------|-----|-----|
| Blush | `#F6E3D6` | Fundo |
| Creme | `#FBF3EC` | Cards / badges |
| Mauve | `#8C6A62` | Detalhe / avatar |
| Mauve profundo | `#6F534B` | Botão principal (CTA) e ícones |
| Marrom | `#4C3A34` | Texto |
| Sálvia | `#C7CBB3` | Detalhe / hairlines |

---

## /odonto — Typeform de qualificação (odontologia)

Formulário estilo Typeform em `odonto/` (URL: `link.ceciclinica.com/odonto`), com
rastreamento server-side:

- `functions/_middleware.js` — cookies first-party + captura de UTM/fbclid em todas as páginas
- `functions/tracker.js` — `POST /tracker` → Meta CAPI (deduplicado com o Pixel por `event_id`)
- `functions/quiz-response.js` — persiste respostas no D1 e cria o lead no Kommo CRM
- `functions/api/` — endpoints de leitura (protegidos por `DASH_KEY`)
- `migrations/` — schema do banco D1

Configuração (binding D1 `DB` + variáveis de ambiente no painel do Cloudflare Pages)
e verificação pós-deploy: ver [docs/TRACKING.md](docs/TRACKING.md).
