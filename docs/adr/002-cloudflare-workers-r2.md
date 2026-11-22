# ADR-002: Deploy em Cloudflare Workers (Static Assets) + R2 na mesma origem

- **Status:** Aceito
- **Data:** 2026-11-21
- **Contexto:** [ADR-001](001-processamento-no-navegador.md) exige processamento 100% local no navegador com `CSP connect-src 'self'`, isolamento de origem (`COOP`/`COEP`/`CORP`) e zero envio de documentos a servidores.

## Problema

O build de produção (`dist/`, ~234 MB) contém dois binários essenciais acima do limite de **25 MiB por arquivo** do Cloudflare Workers/Pages Static Assets (e acima dos 100 MB do plano Vercel Hobby):

1. `models/ner/onnx/model_quantized.onnx` (**171 MB**)
2. `ort/ort-wasm-simd-threaded.asyncify.wasm` (**26 MB**)

Além disso, plataformas com limite de 100 GB/mês de banda no plano gratuito (Render, Vercel) esgotariam a franquia com ~500 novos usuários baixando 197 MB cada.

## Decisão

Hospedar o CleanDoc em **Cloudflare Workers (Static Assets)** combinado com um bucket privado **Cloudflare R2 (`cleandoc-models`)**:

- `scripts/prepare-cf.mjs` monta `dist-cf/` a partir de `dist/`, removendo os 2 binários servidos pelo R2 e a cópia duplicada `assets/ort-wasm-simd-threaded.asyncify-*.wasm` (não usada em runtime), gera `dist-cf/_headers` a partir de `vercel.json` (incluindo `/assets/*` imutável) e falha o build se qualquer arquivo restante exceder 25 MiB.
- `worker/index.ts` intercepta apenas as 2 rotas exatas via `run_worker_first`, faz streaming direto do R2 (`ReadableStream`, sem carregar 171 MB na RAM de 128 MB do Worker), implementa `GET`/`HEAD`, `If-Match` (`412`), `If-None-Match` (`304`), `Range`/`If-Range` (`206`/`416`) e injeta todos os cabeçalhos de segurança (`CSP`, `COOP`, `COEP`, `CORP`, `HSTS`, `X-Content-Type-Options`, `Referrer-Policy`).
- `wrangler.jsonc` configura `not_found_handling: "single-page-application"` (evitando que 404s consumam a cota de 100k req/dia do plano Free) e `observability.enabled: true`.
- O bucket R2 deve manter **Public Development URL (`r2.dev`) desativado**; todo acesso passa exclusivamente pelo Worker na mesma origem.

## Alternativas Consideradas

1. **Cloudflare Pages puro com fatiamento (< 25 MiB):** evitaria R2, mas adicionaria código de recomposição binária no cliente e aumentaria o uso de RAM no navegador.
2. **Render Static Site:** simples e sem limite de 100 MB, mas limitado a 100 GB/mês de egress no plano gratuito.
3. **Vercel Hobby / Pro:** Hobby bloqueia arquivos > 100 MB; Pro tem custo mensal e limite de egress.

## Consequências e Trade-offs

- **Positivo:** Egress gratuito e ilimitado (Static Assets + R2 Free Tier 10 GB), mesma origem preservada (`connect-src 'self'`), zero alterações no pipeline de ML ou nos testes E2E.
- **Trade-off conhecido:** Em `*.workers.dev`, a Cache API de borda não atua como CDN para o stream R2 — cada primeiro acesso com cache de navegador frio consome 2 invocações do limite de 100k req/dia do Worker Free (após o primeiro download, o cache HTTP `immutable` do navegador evita novas chamadas). Ao atualizar `onnxruntime-web` ou o modelo NER no futuro, recomenda-se versionar o caminho dos arquivos para evitar version-skew durante a janela de deploy.
