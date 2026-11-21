# Spec: Doc Cleaner v1

`ATLAS · feature · design+arquitetura · large → pesquisa, descoberta, plano, G1, SDD em worktrees, revisão, verificação, G2 · lanes: design, arquitetura`

## Problema

Antes de enviar um contrato, uma proposta ou uma planilha para fora (para um fornecedor, para um modelo de IA ou para publicação), alguém precisa tirar nomes, empresas, valores, documentos e metadados à mão. É lento e falha. O Doc Cleaner faz isso automaticamente, sem que o documento saia do computador do usuário.

## Requisitos

| # | Requisito | Origem |
|---|---|---|
| R1 | Mascarar com rótulo genérico: pessoas `[nome pessoal]`, empresas/instituições `[empresa]`, locais `[local]`, valores `[valor]`, documentos `[CPF]`/`[CNPJ]`/`[RG]`, contatos `[e-mail]`/`[telefone]`/`[endereço]`, dados bancários/cartão `[dado bancário]`, outros identificadores `[informação]` | usuário |
| R2 | Remover metadados (autor, empresa, datas, software, XMP, revisões, comentários) e marcas d'água | usuário |
| R3 | Vários arquivos por vez: PDF, DOCX, XLSX e CSV | usuário |
| R4 | Não salvar dados: sem servidor de processamento, sem armazenamento persistente, sem analytics | usuário |
| R5 | Não expor dados a IAs externas (Claude, Gemini etc.) | usuário |
| R6 | Cobertura ≈ 99%: recall ≥ 99% por categoria no conjunto de teste PT-BR | usuário |
| R7 | O usuário informa vários termos, nomes e informações adicionais em campos, por categoria | usuário |
| R8 | Detecção com ML clássico (classificadores), self-attention e NLU focados em PT-BR | usuário |
| R9 | Interface simples, minimalista e moderna; deploy simples | usuário |

## Fora do escopo da v1

- OCR de PDF escaneado e de imagens. O arquivo é aceito, só os metadados são limpos e a interface avisa.
- PPTX e imagens soltas.
- Contas, histórico e compartilhamento.

## Solução

Aplicação web estática, com processamento 100% no navegador. A decisão está em [ADR-001](../../adr/001-processamento-no-navegador.md).

Detecção em ensemble, priorizando o recall:

0. **Termos do usuário** (R7), com variações geradas automaticamente: iniciais, sobrenome isolado, forma sem acento, caixa.
1. **Regras com validação**: dígito verificador de CPF/CNPJ, Luhn para cartão, RG, CEP, telefone, e-mail, PIX, agência/conta, placa, valores numéricos e por extenso.
2. **ML clássico** (R8): CRF para rotular sequências e regressão logística para classificar e calibrar spans. O treino é offline em Python; a inferência roda em TypeScript a partir de pesos em JSON.
3. **Self-attention** (R8): BERTimbau ajustado para NER (PER/ORG/LOC) em LeNER-Br, HAREM e corpus sintético, quantizado int8/ONNX e executado via transformers.js num Web Worker.
4. **NLU PT-BR** (R8): normalização, contrações, pronomes de tratamento, cargos, anáforas leves ("a referida empresa"), números por extenso, endereços. A propagação mascara a mesma entidade em todos os arquivos.
5. **Fusão**: alta precisão (0 e 1) vence; o ensemble de ML entra com limiar baixo. Revisão humana na interface.

Limpeza por formato:
- **PDF**: redação real com mupdf.js e remoção de Info, XMP, anotações, OCG e artefatos `/Watermark`.
- **DOCX**: reescrita do XML (`docProps`, comentários, revisões, rsid, marcas d'água em cabeçalhos, EXIF das mídias).
- **XLSX/CSV**: SheetJS e PapaParse (células, nomes de abas, comentários, propriedades).

## Interface

- Brief: [design-brief.md](design-brief.md).
- Figma: https://www.figma.com/design/yEXRB3VvfRO17jGUWVIe2I

## Critérios de aceite

- [ ] Recall ≥ 99% por categoria e precisão ≥ 90% no conjunto de teste PT-BR (gate no CI).
- [ ] Nenhuma requisição de rede com conteúdo do documento: CSP `connect-src 'self'` e teste E2E que intercepta a rede.
- [ ] Nada em `localStorage`/IndexedDB; "Limpar sessão" zera o estado.
- [ ] PDF de saída sem o texto original: extrair texto do PDF limpo não encontra nenhum valor mascarado.
- [ ] DOCX/XLSX de saída sem metadados de autoria nem marca d'água (checagem automática do XML).
- [ ] Todas as telas e estados do brief implementados, com WCAG 2.2 AA verificado.
- [ ] Deploy estático na Vercel com um comando.

## Riscos

| Risco | Mitigação |
|---|---|
| 99% de recall não é atingível só com modelo | Ensemble + termos do usuário + revisão humana; meta medida por categoria, não declarada |
| Modelo transformer pesado (~110 MB) | int8, carregamento sob demanda, cache do navegador, progresso visível; o CRF dá resultado antes |
| mupdf.js é AGPL | Repositório aberto; alternativa documentada no ADR |
| Falta de dados anotados de documentos reais PT-BR | Gerador sintético com templates de contrato, nota e planilha + Faker pt_BR |
