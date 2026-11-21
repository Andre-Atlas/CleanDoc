# ADR-001: processamento 100% no navegador com ensemble local de detecção

- Status: proposto (Gate 1)
- Data: 2026-11-21

## Contexto

O Doc Cleaner precisa anonimizar documentos com cobertura de ~99%, sem salvar dados, sem expor conteúdo a IAs externas e com deploy simples. Os documentos são em português do Brasil.

## Alternativas

1. **Navegador + ensemble local (escolhida).** Site estático. Regras, CRF/LogReg, BERTimbau ONNX e NLU rodam em Web Workers.
   - Custo: o primeiro carregamento baixa ~110 MB de modelo; o código de inferência do CRF é próprio.
2. **Servidor stateless (Python + spaCy/Presidio).**
   - Melhor ecossistema de NLP, mas o arquivo trafega pela rede.
   - O deploy exige container.
   - "Não salvar" vira promessa de operação, não garantia técnica.
3. **Navegador + LLM externo.** Descartada por R5.

## Decisão

Alternativa 1:
- **Stack:** Vite + React + TypeScript.
- **Workers:** um Web Worker para parsing e limpeza, um para modelos.
- **Bibliotecas:** transformers.js (onnxruntime-web), mupdf.js, JSZip, SheetJS, PapaParse.
- **Deploy:** Vercel estática.
- **Treino:** pasta `ml/` em Python, fora do bundle. Ela exporta `crf.json`, `logreg.json` e `ner-int8.onnx` para `public/models/`.

## Consequências

- A privacidade é verificável: CSP `connect-src 'self'` e nenhum endpoint de backend.
- A qualidade depende de treino e avaliação próprios. Um conjunto de teste PT-BR versionado e um gate de recall no CI são obrigatórios.
- mupdf.js (AGPL) exige repositório aberto. Se isso mudar, a alternativa é rasterizar páginas com conteúdo mascarado (perde o texto selecionável).
- Sem OCR na v1: PDFs escaneados só têm os metadados limpos.
