# Plano — Limite 500 MB, OCR Local + Limpeza de Marca d'Água Rasterizada, `.zip` e Controle de Gastos Cloudflare

> Classificação: `ATLAS · feature · arquitetura+infra+design · large → pesquisa, descoberta, plano+ADR, G1, SDD, revisão, verificação, G2 · lanes: arquitetura, design`

## Tarefas

### T1 `[infra]` — Controle de gastos na Cloudflare (60% R2 + \$1 budget)
- Usar o MCP `cloudflare_cloudflare` (`execute`) para:
  - Criar política `billing_budget_alert` em **\$1** para `andrealvesacioli@gmail.com`.
  - Criar políticas `billing_usage_alert` em **60% do free tier do R2** (`r2_storage` = 6 GB, `r2_class_a_operations` = 600.000, `r2_class_b_operations` = 6.000.000).
  - Confirmar que `r2.dev` continua `enabled: false` no bucket `cleandoc-models`.
- Registrar os IDs das políticas criadas no ledger.

### T2 `[arch]` — Limite de tamanho (500 MB / 1 GB) + contrato de tipos e ativos OCR self-hosted
- Elevar `MAX_BYTES` para `500 * 1024 * 1024` (500 MB) em `src/ui/useCleaner.ts` e `src/worker/engine.ts`, e `MAX_UNCOMPRESSED` para `1024 * 1024 * 1024` (1 GB) em `src/formats/package.ts`.
- Adicionar `image` em `FileKind` (`src/core/types.ts` e `src/formats/types.ts`), com magic bytes para PNG, JPEG e WEBP.
- Instalar `tesseract.js` e atualizar `scripts/fetch-models.mjs` para:
  - Baixar `por.traineddata.gz` (tessdata_fast, ~1.5–4 MB) com **SHA-256 fixado** em `public/models/ocr/`.
  - Copiar `worker.min.js` e `tesseract-core-simd.wasm(.js)` de `node_modules` para `public/ocr/` (sem CDN externa).
- Atualizar `.gitignore` (`public/ocr/`, `public/models/ocr/`), `scripts/prepare-cf.mjs` (cache `/ocr/*`) e escrever ADR-003 em `docs/adr/003-ocr-local-e-zip.md`.

### T3 `[core]` — Módulo OCR local (`src/formats/ocr.ts`), filtro de marca d'água rasterizada e parser de imagens (`src/formats/image.ts`)
- Implementar `src/formats/ocr.ts` (lazy-load `tesseract.js` com `workerPath`, `corePath`, `langPath`, `workerBlobURL: false`, interface `OcrEngine` injetável para testes unitários).
- Implementar filtro de limpeza de marca d'água clara/pastel sobre fundo branco (`stripLightWatermark(rgba, width, height)`) em `src/formats/watermark.ts` com testes unitários (verifica que remove lavanda/cinza claro preservando texto escuro e cabeçalhos azul-escuro).
- Implementar `src/formats/image.ts` (`parseImage`): extrai texto + bboxes via OCR, aplica filtro de marca d'água opcional, redige pixels com rótulos em `OffscreenCanvas` e exporta imagem limpa sem EXIF/metadados.
- Testes unitários em `src/formats/image.test.ts` e `src/formats/watermark.test.ts`.

### T4 `[core]` — OCR + limpeza de marca d'água rasterizada em PDFs escaneados (`src/formats/pdf.ts`)
- Atualizar `parsePdf` para aceitar `{ ocr?: OcrEngine; stripRasterWatermark?: boolean; onPageProgress?: (p, total) => void }`.
- Para páginas com `< 20` caracteres de texto extraído:
  - Renderizar via `mupdf` (`toPixmap` em 200 DPI) → opcionalmente aplicar `stripLightWatermark` e substituir a imagem da página no `apply()` → rodar OCR local → mapear bboxes de palavras para `Quad` em coordenadas da página PDF.
  - Na aplicação (`apply`), o `mupdf` apaga os pixels reais sob cada `Redact` (`applyRedactions(false, 2, 2, 0)`) e desenha os rótulos `[nome pessoal]`, `[empresa]`, etc.
- Testes unitários cobrindo PDF rasterizado com mock de `OcrEngine`.

### T5 `[core]` — Suporte a `.zip` com proteção contra zip bomb e path traversal (`src/formats/zip.ts` + UI/Worker)
- Implementar `src/formats/zip.ts` (`extractZipFiles`):
  - Descompacta `.zip` via `JSZip`, rejeita path traversal (`..`, paths absolutos, bytes nulos), bloqueia zip bomb (limite de 1 GB descomprimido, 5.000 entradas, razão de compressão abusiva), e extrai todos os arquivos suportados (`PDF`, `DOCX`, `XLSX`, `CSV`, `PNG`, `JPG`, `WEBP`) preservando o caminho relativo (`relativePath`).
- Integrar na entrada (`useCleaner.ts` + `Entrada.tsx`) e na tela de conclusão (`Concluido.tsx`) para baixar o `.zip` limpo preservando a estrutura de pastas.
- Testes unitários em `src/formats/zip.test.ts` (zip válido com subpastas, path traversal bloqueado, zip bomb bloqueado, arquivos ignorados).

### T6 `[design]` — Ajustes de interface (`Entrada.tsx`, `Revisao.tsx`, `Concluido.tsx`)
- Atualizar dropzone e hints para `PDF, DOCX, XLSX, CSV, imagens (PNG/JPG/WEBP) ou ZIP · até 500 MB cada`.
- Adicionar toggle acessível na entrada/revisão: **"Remover marcas d'água claras em PDFs/imagens escaneados"** (ligado por padrão).
- Exibir aviso não bloqueante para arquivos > 100 MB e progresso de OCR página a página.

### T7 `[core]` — Verificação, revisão ATLAS e Gate 2
- Rodar `npm run typecheck`, `npm run lint`, `npm test`, `npm run build:cf`, `npx wrangler deploy --dry-run`.
- Rodar revisores: `code-reviewer`, `react-reviewer`, `security-reviewer`, `architect`.
- Apresentar resumo no Gate 2 para commit, push e `npm run deploy:cf`.
