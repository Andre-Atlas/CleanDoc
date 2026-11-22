# Spec — Deploy do CleanDoc em Cloudflare Workers (Static Assets) + R2

## 1. Objetivo
Publicar o CleanDoc (`Andre-Atlas/CleanDoc`) na nuvem de forma independente da máquina local, com link público aberto para qualquer pessoa, preservando 100% das garantias de privacidade e desempenho do aplicativo:
- Processamento integral no navegador do usuário (zero backend de dados, zero upload de documentos).
- Mesma origem (`CSP connect-src 'self'`), sem CDNs externas.
- Isolamento de origem ativo (`COOP: same-origin`, `COEP: require-corp`, `CORP: same-origin`) para habilitar threads WASM no ONNX Runtime e MuPDF.
- Custo \$0 no plano gratuito da Cloudflare, com **egress (banda) ilimitado** via R2 + Static Assets.

## 2. Contexto Técnico e Restrições
O build de produção (`dist/`, ~234 MB) contém três arquivos acima do limite de **25 MiB por arquivo** do Cloudflare Workers Static Assets:
1. `dist/models/ner/onnx/model_quantized.onnx` (**171 MB**) — pesos do BERTimbau NER.
2. `dist/ort/ort-wasm-simd-threaded.asyncify.wasm` (**26 MB**) — runtime WASM do ONNX.
3. `dist/assets/ort-wasm-simd-threaded.asyncify-*.wasm` (**26 MB**) — cópia duplicada emitida pelo bundler, não utilizada em runtime (o app carrega `/ort/ort-wasm-simd-threaded.asyncify.wasm` explicitamente via `src/detect/transformer.ts`).

## 3. Arquitetura Escolhida
- **Static Assets (`dist-cf/`)**: recebe toda a aplicação Vite (HTML, JS, CSS, fontes, JSONs do CRF/LogReg/Gazetteer, tokenizer do NER e MuPDF WASM), todos abaixo de 25 MiB, com cabeçalhos de segurança definidos em `dist-cf/_headers` (gerado a partir de `vercel.json` como fonte única da verdade).
- **Cloudflare R2 (`cleandoc-models`)**: armazena exclusivamente os dois binários > 25 MiB (`models/ner/onnx/model_quantized.onnx` e `ort/ort-wasm-simd-threaded.asyncify.wasm`).
- **Cloudflare Worker (`worker/index.ts`)**: acionado via `run_worker_first` apenas nas duas rotas exatas dos binários grandes. Faz streaming direto do R2 (`object.body`, sem carregar 171 MB na RAM do Worker), respeita `GET`/`HEAD`/`If-None-Match` (`304`)/`Range` (`206`), e aplica todos os cabeçalhos de segurança (`COOP`, `COEP`, `CORP`, `Cache-Control: immutable`, `X-Content-Type-Options`, `Referrer-Policy`, `HSTS`).

## 4. Critérios de Aceitação
1. `npm run build:cf` gera `dist-cf/` completo com `_headers` válido e **nenhum** arquivo > 25 MiB (falha imediatamente se houver).
2. `worker/index.ts` serve apenas as 2 rotas da whitelist via R2, recusa métodos diferentes de `GET`/`HEAD` (`405`), trata objeto ausente (`404`) e preserva `ETag`/`304`/`Range`.
3. Todas as demais rotas caem em `env.ASSETS.fetch(request)` sem tocar o R2.
4. Fluxo local existente (`npm run dev`, `npm run build`, `npm test`, `npm run lint`, `npm run e2e`) permanece intacto e verde.
5. Deploy via `wrangler` cria/popula o bucket R2 e publica o Worker em `*.workers.dev`, com validação em produção dos cabeçalhos de segurança e carregamento real do modelo NER.

## 5. Fora de Escopo
- Autenticação ou restrição de acesso (usuário confirmou link público aberto).
- Domínio customizado (pode ser adicionado depois no painel Cloudflare sem alterar código).
- Alteração no pipeline de ML ou no código de anonimização (`src/`).
