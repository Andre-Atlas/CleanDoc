# Plano — Deploy Cloudflare Workers + R2

> Classificação: `ATLAS · feature · infra+arquitetura · standard → pesquisa, descoberta, plano, G1, SDD, revisão, verificação, G2 · lanes: arquitetura`

## Tarefas

### T1 `[arch]` — Configuração Wrangler e contrato de cabeçalhos
- Criar `wrangler.jsonc` configurando:
  - `name: "cleandoc"`, `main: "worker/index.ts"`, `compatibility_date: "2026-11-21"`
  - `assets`: `directory: "./dist-cf"`, `binding: "ASSETS"`, `run_worker_first: ["/models/ner/onnx/model_quantized.onnx", "/ort/ort-wasm-simd-threaded.asyncify.wasm"]`
  - `r2_buckets`: `binding: "MODELS_BUCKET"`, `bucket_name: "cleandoc-models"`
- Adicionar `dist-cf` e `.wrangler` ao `.gitignore`.
- Adicionar `wrangler` (e `@cloudflare/workers-types` se necessário para tipagem estrita do Worker) em `devDependencies` no `package.json`, junto com os scripts `build:cf`, `cf:upload-models` e `deploy:cf`.

### T2 `[core]` — Worker de streaming R2 + testes unitários (TDD)
- Escrever `worker/index.test.ts` cobrindo:
  - `GET` e `HEAD` das duas rotas whitelistadas (`/models/ner/onnx/model_quantized.onnx` e `/ort/ort-wasm-simd-threaded.asyncify.wasm`), verificando `Content-Type`, `COOP`, `COEP`, `CORP`, `Cache-Control: immutable`, `ETag`, `X-Content-Type-Options`, `Referrer-Policy`, `HSTS`.
  - `If-None-Match` retornando `304 Not Modified`.
  - `Range` retornando `206 Partial Content` com `Content-Range`.
  - Método não permitido (`POST`) retornando `405`.
  - Objeto ausente no R2 retornando `404`.
  - Qualquer outra rota (incluindo tentativas de path traversal como `/models/../secret`) delegando para `env.ASSETS.fetch(request)` sem consultar o R2.
- Implementar `worker/index.ts` passando todos os testes.

### T3 `[core]` — Script de preparação do bundle Cloudflare (`scripts/prepare-cf.mjs`) e upload R2 (`scripts/upload-r2.mjs`)
- Implementar `scripts/prepare-cf.mjs`:
  - Garante que `dist/` existe.
  - Copia `dist/` para `dist-cf/` removendo os 2 binários servidos pelo R2 e o duplicado `assets/ort-wasm-simd-threaded.asyncify-*.wasm`.
  - Gera `dist-cf/_headers` a partir de `vercel.json` (fonte única da verdade), incluindo `Cache-Control: immutable` para `/models/*` e `/ort/*`.
  - Valida que nenhum arquivo em `dist-cf/` ultrapassa 25 MiB (`25 * 1024 * 1024` bytes), abortando com erro claro caso contrário.
- Implementar `scripts/upload-r2.mjs`:
  - Garante que os binários locais existem (rodando verificação SHA-256 ou `fetch-models.mjs`).
  - Executa `npx wrangler r2 object put cleandoc-models/<key> --file <path> --content-type <mime> --remote` para os 2 arquivos.
- Adicionar teste unitário para a geração de `_headers` e validação de tamanho.

### T4 `[core]` — Documentação e verificação completa
- Atualizar seção `## Deploy` do `README.md` com o fluxo Cloudflare Workers + R2 (setup único do bucket + upload + deploy).
- Rodar verificação completa: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build:cf`.
- Revisão por `code-reviewer`, `typescript-reviewer`, `architect` e `security-reviewer` (gatilho: cabeçalhos HTTP, CSP e exposição pública de rotas).

### T5 `[gate-2]` — Execução do deploy real (após aprovação no Gate 2)
- Autenticar `npx wrangler login` (interativo no navegador do usuário, caso ainda não esteja logado).
- Criar bucket `cleandoc-models` (se não existir), rodar `npm run cf:upload-models` e `npm run deploy:cf`.
- Verificar na URL pública `*.workers.dev` os cabeçalhos HTTP e o carregamento do app.
