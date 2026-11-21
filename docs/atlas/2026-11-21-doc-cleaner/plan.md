# Plano: Doc Cleaner v1

Spec: [spec.md](spec.md) · Brief: [design-brief.md](design-brief.md) · ADR: [001](../../adr/001-processamento-no-navegador.md)

Execução: `subagent-driven-development` em worktrees, uma fatia vertical por vez. Cada tarefa nasce com teste (TDD).

## Fase A: fundação

- [arch] Contratos em `src/core/types.ts`:
  - `Entity {start,end,text,category,sources[],confidence}`, `Detector`, `FileJob`, `CleanReport`.
  - Mensagens worker↔UI.
  - Teste de tipos e de serialização.
- [arch] Scaffold Vite + React + TS, Vitest, Playwright, CSP estrita em `vercel.json`, ESLint que proíbe `localStorage` e `fetch` fora de `/models`.
- [design] Tokens: CSS variables geradas das variáveis do Figma (claro/escuro).

## Fase B: detecção

- [data] `ml/data/`: gerador sintético PT-BR (contratos, notas, planilhas) com Faker pt_BR e anotação BIO. Inclui conversores de LeNER-Br e HAREM e um split de teste congelado.
- [core] Camada 0, termos do usuário: variações (iniciais, sobrenome, sem acento) e matcher Aho-Corasick.
- [core] Camada 1, regras com validadores (CPF/CNPJ DV, Luhn, RG, CEP, telefone, e-mail, PIX, conta, placa, valores e números por extenso).
- [core] Camada 2, CRF:
  - Treino em `ml/crf/` (sklearn-crfsuite) e export `crf.json`.
  - Inferência Viterbi em TS.
  - Teste de paridade Python×TS no split de teste.
- [core] Camada 2b: regressão logística de spans (scikit-learn), export `logreg.json` e inferência TS.
- [core] Camada 3, transformer:
  - Fine-tuning BERTimbau NER em `ml/ner/`, export ONNX int8.
  - Worker com transformers.js e tokenização em janelas com sobreposição.
- [core] Camada 4, NLU PT-BR: normalização, contrações, tratamentos, anáforas leves, números por extenso, propagação entre arquivos.
- [core] Fusão e calibração de limiar; relatório de recall/precisão por categoria; gate no CI (recall ≥ 99%).

## Fase C: formatos

- [core] DOCX: extração de texto por run, substituição preservando a formatação, limpeza de docProps/comentários/revisões/rsid/marca d'água/EXIF. Testes com fixtures.
- [core] XLSX/CSV: células, abas, comentários, propriedades.
- [core] PDF (mupdf.js): extração com posições, redação real, remoção de Info/XMP/anotações/OCG/watermark, detecção de PDF escaneado. Teste: o texto extraído do PDF limpo não contém valores mascarados.

## Fase D: interface (componentes e telas do Figma)

- [design] Componentes: Button, Badge, MaskChip, TermChip, TermInput, Toggle, CategoryToggle, FileRow, Dropzone, AppHeader, PrivacySeal. Todos os estados, teclado, teste de componente por estado.
- [design] Tela Entrada (vazio, arquivos, termos, carregando modelos, formato inválido).
- [design] Tela Processamento (estados por arquivo, progresso por etapa, `aria-live`).
- [design] Tela Revisão (preview com chips, popover, painel de categorias, adicionar termo, metadados; abas no mobile; nenhuma detecção).
- [design] Tela Concluído (downloads individuais e ZIP, relatório, limpar sessão).

## Fase E: verificação e entrega

- [core] E2E Playwright: fluxo completo com 3 formatos; interceptação de rede prova zero envio; storage vazio após "Limpar sessão".
- [audit] `production-audit` + `security-reviewer` (entrada de arquivo, CSP, dependências) + `a11y-architect`.
- Deploy na Vercel (estático) e README com instruções e limitações (OCR fora da v1).

## Ledger

- Ruling: tokens nasceram em coleção única de 2 modos (Color) + Size, sem camada de primitivos — < 50 tokens — se crescer, separar primitivos sem mudar os nomes semânticos.
- Ruling: TermInput e AppHeader viraram componentes (repetem entre telas) — custo zero se errado.

### Execução (Gate 1 aprovado em 2026-11-21)

- Ruling: execução inline na branch `feat/doc-cleaner-v1` em vez de SDD em worktrees — repositório sem commits e fatias muito acopladas (contratos compartilhados) — custo: menos isolamento entre fatias; compensado com revisão paralela por 3 agentes na fase 5.
- Ruling: em vez de fazer fine-tuning do BERTimbau, usar o modelo público já ajustado em LeNER-Br e exportado para ONNX (`augustaklug/legal-bert-ner-base-cased-ptbr-onnx`, CC-BY-4.0, 172 MB int8) — fine-tuning exige GPU e dados anotados reais — custo: rótulos LeNER (PESSOA/ORGANIZACAO/LOCAL) e domínio jurídico; mitigado pelo ensemble.
- Ruling: o corpus de treino e teste é sintético (Faker pt_BR + templates). O teste usa templates exclusivos. LeNER-Br/HAREM não foram convertidos para o CRF — custo: as métricas valem para o sintético, não para documentos reais.
- Ruling: SheetJS removido; XLSX processado direto no XML (como DOCX) para preservar formatação — custo: nomes de abas não são mascarados (aviso na UI).
- Ruling: CSP sem `blob:` em script-src; `env.useWasmCache=false` e runtime ONNX em `/ort/` — sem isso, o transformers.js baixa o runtime de cdn.jsdelivr.net (requisição externa) ou o bloqueia via blob.
- Ruling: tempo-limite de 180 s para o transformer; se não carregar, a análise segue com as outras camadas e a UI informa.
- Ruling: inferência por coluna em CSV/XLSX (cabeçalho semântico + maioria). Origem: o E2E pegou "Renato Siqueira" vazando numa célula sem contexto.
- Ruling: na fusão, quando só há fontes estatísticas, o trecho é a união do grupo (recall > fronteira exata).

### Resultado da avaliação (corpus sintético, templates não vistos)

Ensemble completo: recall mascarado de 100% em pessoa, local, valor, documento, contato e bancário; empresa 99,9%; precisão por caractere 94%. Ver `eval.json` (sem transformer) e `eval-ner.json`.

### Revisão (fase 5): 3 revisores em paralelo

Achados confirmados e corrigidos (todos com teste de regressão):

- Segurança, CRITICAL:
  - PDF: anotações, formulários, marcadores, anexos AF, miniaturas, texto fora da página e conteúdo de camada OCG sobreviviam.
  - DOCX/XLSX: gráficos, SmartArt, equações, alt text, desenhos, tabelas dinâmicas e configurações de impressora não eram processados.
- Segurança, HIGH: autoria em `*PrChange`, alvos externos nas relações, imagem órfã de marca d'água, comentários do ZIP, ReDoS cúbico na NLU.
- Corretude, HIGH:
  - valores sem separador de milhar vazavam dígitos;
  - `t="str"` e fórmulas com atributos no XLSX;
  - exceção no worker travava a UI.
- Corretude, MEDIUM: NFD, `<si>` vazio desalinhando índices, telefone sem separadores, palavras puladas pelo transformer.
- React/a11y, HIGH:
  - "aplicando" podia travar ou omitir arquivo com erro;
  - "Voltar" sem saída;
  - foco perdido em toda troca de tela;
  - contraste de bordas de controle < 3:1;
  - tabs com semântica inválida;
  - sem ESLint.
- MEDIUM/LOW em geral: correlação por `runId`; geração do worker; `onerror`; popover; nomes acessíveis; `role=alert`; cor como único sinal; `scroll-padding`; CSV Windows-1252 e escape de fórmulas; nome do arquivo de saída mascarado; limites de zip bomb e páginas; modelo com revisão fixada + SHA-256; CSP sem `blob:`; ORT falha fechado; sem Cache Storage.

Rulings da revisão:

- Ruling: autoverificação pós-limpeza (reabrir e procurar termos) emite aviso em vez de bloquear o download — evita falso positivo travar o usuário (ex.: termo genérico que é também nome de estilo) — custo: depende de o usuário ler o aviso; a tela final usa `role=alert`.
- Ruling: conteúdo não analisável (anexos, OLE, tabelas dinâmicas, anotações e formulários de PDF) é REMOVIDO e listado no relatório, em vez de mantido — privacidade > fidelidade — custo: o usuário perde esses elementos.
- Ruling: nomes de abas do XLSX não são alterados (referências em fórmulas). A autoverificação e um aviso cobrem — custo: dado pessoal em nome de aba exige ação manual.
- Ruling: divergência TS × Python em caracteres Unicode exóticos (`²`, `½`, dígitos não ASCII, texto NFD) aceita e documentada. Os segmentos de OOXML e CSV agora são normalizados em NFC — custo: features levemente diferentes perto desses caracteres; a paridade é verificada no corpus.
- Ruling: TypeScript fixado em 5.9 (era 7.0) porque o typescript-eslint ainda não suporta o TS 7 — custo: nenhum funcional.
- Ruling: o servidor de dev não aplica a CSP, porque o HMR do Vite usa script inline. O E2E roda no build de produção com a CSP real.
