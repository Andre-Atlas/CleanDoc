# Ledger — Deploy Cloudflare Workers + R2

- **Classificação:** `ATLAS · feature · infra+arquitetura · standard → pesquisa, descoberta, plano, G1, SDD, revisão, verificação, G2 · lanes: arquitetura`
- **Data:** 2026-11-21

## Decisões de Descoberta
- **Plataforma:** Cloudflare Workers (Static Assets) + Cloudflare R2 (escolhida pelo usuário por egress gratuito ilimitado e mesma origem).
- **Acesso:** Link público aberto (confirmado pelo usuário).
- **Motivo do R2:** 2 arquivos essenciais excedem o limite de 25 MiB do Cloudflare Static Assets (`model_quantized.onnx` 171 MB e `ort-wasm-simd-threaded.asyncify.wasm` 26 MB), além de 1 cópia duplicada não usada em `dist/assets/ort-wasm-simd-threaded.asyncify-*.wasm` (26 MB).

## Rulings (entre Gate 1 e Gate 2)
- Ruling: Usar interfaces estruturais mínimas (`R2Object`, `R2ObjectBody`, `R2Bucket`, `Fetcher`) em `worker/index.ts` em vez de adicionar `@cloudflare/workers-types` ao `tsconfig.json` global — evita conflito de tipos globais (`Request`/`Response`/`Headers`) entre `DOM`/`WebWorker` de `src/` e o runtime Workers, mantendo um único `tsc -b` — custo se errado: trivial (adicionar `tsconfig.worker.json`).
- Ruling: Tratar `Range`/`If-Range`/`If-Match`/`If-None-Match` explicitamente em `worker/index.ts` (em vez de repassar `request.headers` direto ao R2) — corrige os 2 achados HIGH de `code-reviewer` e `architect` (`416` em range insatisfatível, `200` em `If-Range` divergente/multi-range, `412` em `If-Match` e `304` em `HEAD`), mantendo apenas 1 chamada R2 no caminho feliz (`GET` simples) — custo se errado: baixo, totalmente coberto por testes unitários.
- Ruling: Manter URLs atuais `/models/ner/onnx/model_quantized.onnx` e `/ort/ort-wasm-simd-threaded.asyncify.wasm` sem alterar `src/` nesta entrega — preserva escopo aprovado no Gate 1 (zero mudanças em `src/`), documentando o trade-off de version-skew no ADR-002 para futuras trocas de modelo — custo se errado: baixo (adicionar hash/versão no path quando trocar o modelo).
