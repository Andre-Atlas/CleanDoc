# Doc Cleaner

Anonimiza documentos **no seu navegador**: nomes, empresas, locais, valores, documentos (CPF/CNPJ/RG), contatos e dados bancários viram rótulos como `[nome pessoal]` e `[empresa]`, e metadados e marcas d'água são removidos. Nenhum arquivo sai do computador e nada é salvo.

Formatos: **PDF, DOCX, XLSX e CSV**, vários de uma vez.

## Como funciona

A detecção é um ensemble local em PT-BR. Cada camada cobre o que a outra deixa passar:

| Camada | O que faz | Onde |
|---|---|---|
| 0. Termos do usuário | nomes/empresas/locais/outros informados em campos, com variações (sem acento, iniciais, só o sobrenome) | `src/detect/userTerms.ts` |
| 1. Regras validadas | CPF/CNPJ (dígito verificador), cartão (Luhn), RG, CEP, telefone, e-mail, PIX, agência/conta, placas, endereços, valores numéricos e por extenso | `src/detect/rules.ts` |
| 2. ML clássico | CRF (rotulagem de sequência) + regressão logística (classificação de spans), treinados em Python e executados em TS | `ml/`, `src/detect/crf.ts` |
| 3. Self-attention | BERTimbau ajustado para NER (LeNER-Br), ONNX int8 via transformers.js num Web Worker | `src/detect/transformer.ts` |
| 4. NLU PT-BR | tratamentos ("Dra."), papéis contratuais, sufixos societários, preposições de lugar, propagação entre arquivos | `src/detect/nlu.ts` |
| Fusão | une os candidatos e prioriza o recall; títulos estruturais são descartados | `src/detect/fuse.ts` |
| Tabelas | inferência por coluna (cabeçalho "nome", "cidade", "salário"… e maioria) | `src/formats/columns.ts` |

A revisão humana fecha a lacuna. A interface mostra cada detecção com as fontes e a confiança, e permite desligar categorias, desfazer um item, trocar a categoria e adicionar termos que ficaram de fora.

### Qualidade medida

Conjunto de teste sintético PT-BR com 1.500 documentos, gerado a partir de **templates não vistos no treino** (`ml/gen.py`). As métricas estão em `docs/atlas/2026-11-21-doc-cleaner/eval*.json`.

| Métrica | Ensemble completo | Sem transformer |
|---|---|---|
| Recall (dado mascarado) — todas as 7 categorias | 100% | 100% (empresa 99,9%) |
| Precisão por caractere | 94% | 94% |

Os números valem para o corpus sintético. Em documentos reais, a revisão na interface continua necessária. PDFs escaneados não têm OCR: deles só os metadados são limpos, e a interface avisa.

### Limpeza por formato

- **PDF** (mupdf.js): redação real, em que o texto sai do conteúdo e não é só coberto. Remove Info, XMP, ID, anexos, anotações e conteúdo `/Watermark`, e desliga camadas de marca d'água.
- **DOCX**: aceita revisões, remove comentários e autores, marcas d'água de cabeçalho, `docProps`, `customXml`, rsids, variáveis do documento e EXIF das imagens. O texto é substituído preservando runs e formatação.
- **XLSX**: strings compartilhadas, células numéricas (CPF, salário pela coluna), comentários/notas/autores, caminho absoluto do arquivo, vínculos externos e propriedades.
- **CSV**: célula a célula, preservando delimitador, BOM e quebras de linha.

## Privacidade (verificável)

- CSP `connect-src 'self'` em `vercel.json`: o app só fala com a própria origem. O modelo e o runtime ONNX são servidos pelo site (`/models`, `/ort`), nunca por CDN.
- Nada vai para `localStorage`, `sessionStorage`, IndexedDB ou Cache Storage (proibido também por regra de lint). O modelo volta do cache HTTP do navegador.
- "Limpar sessão" encerra o worker e descarta tudo da memória.
- O modelo é baixado de uma revisão fixada do Hugging Face e conferido por SHA-256 no build.
- O E2E (`e2e/flow.spec.ts`) falha se qualquer requisição sair da origem, se algo for persistido ou se um valor sensível aparecer no arquivo limpo.
- Cada arquivo limpo passa por **autoverificação**: o pacote ou PDF de saída é reaberto e varrido em busca dos termos mascarados. Se algo sobrar, a tela final avisa.

### O que é removido sem análise

Conteúdo que não dá para analisar com segurança sai do arquivo em vez de ficar:
- **PDF:** anotações e comentários, campos de formulário, marcadores, anexos, miniaturas, JavaScript e camadas de marca d'água.
- **DOCX:** objetos incorporados e glossário.
- **XLSX:** tabelas dinâmicas e seus caches, configurações de impressora e objetos incorporados.

A tela final lista o que saiu.

## Desenvolvimento

```bash
npm install
npm run dev          # baixa o modelo NER (~172 MB, só na primeira vez) e sobe em http://localhost:5173
npm test             # unidade + paridade Python×TS + gate de recall
npm run lint         # ESLint (hooks, jsx-a11y, proibição de armazenamento)
npm run e2e          # build de produção com a CSP real + fluxo completo no Chromium
NER=1 npx vitest run src/eval --environment node   # avaliação com o transformer
```

Retreinar o ML clássico:

```bash
python3 -m venv ml/.venv && ml/.venv/bin/pip install sklearn-crfsuite scikit-learn faker
ml/.venv/bin/python ml/gen.py 8000 && ml/.venv/bin/python ml/train.py
```

`ml/common.py` e `src/detect/features.ts` são espelhos exatos. O teste de paridade quebra se divergirem.

## Deploy

Site estático, com processamento 100% no navegador.

### Cloudflare Workers (Static Assets) + R2 (recomendado — egress gratuito ilimitado)

Como o modelo NER (`171 MB`) e o runtime ONNX (`26 MB`) excedem o limite de 25 MiB por arquivo do Cloudflare Static Assets, eles ficam num bucket R2 e são servidos na **mesma origem** por `worker/index.ts` (preservando `CSP connect-src 'self'` e `COOP/COEP/CORP`):

```bash
# 1. Autenticar na Cloudflare (uma única vez)
npx wrangler login

# 2. Criar o bucket R2 e enviar os 2 binários > 25 MiB (uma única vez ou ao trocar de modelo)
npx wrangler r2 bucket create cleandoc-models
npm run models:fetch
npm run cf:upload-models

# 3. Gerar o bundle dist-cf/ e publicar o Worker
npm run deploy:cf
```

### Vercel (plano Pro)

Na Vercel Pro (suporta até 1 GB por arquivo estático), importe o repositório com framework Vite. O `prebuild` baixa o modelo e copia o runtime ONNX, e o `vercel.json` aplica a CSP e o cache dos modelos. (No plano Vercel Hobby, o limite é 100 MB por arquivo, abaixo dos 171 MB do modelo ONNX.)

## Licenças

- Código: Copyright (c) 2026 André Acioli, sob AGPL-3.0-or-later (ver `LICENSE`). A AGPL é exigida pelo mupdf.js, usado na redação real de PDF.
- Modelo NER: [`augustaklug/legal-bert-ner-base-cased-ptbr-onnx`](https://huggingface.co/augustaklug/legal-bert-ner-base-cased-ptbr-onnx), CC-BY-4.0, derivado de `dominguesm/legal-bert-ner-base-cased-ptbr` (BERTimbau ajustado em LeNER-Br).
- Nomes do gazetteer vêm do Faker pt_BR (MIT).
