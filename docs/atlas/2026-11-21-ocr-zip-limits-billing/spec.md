# Spec — Limite Máximo de Tamanho, OCR Local + Remoção de Marca d'Água Rasterizada, Suporte a `.zip` e Controle de Gastos Cloudflare

## 1. Objetivo
Expandir o CleanDoc em quatro frentes sem comprometer a privacidade local (`CSP connect-src 'self'`, processamento 100% no navegador, zero persistência):
1. **Limite máximo de tamanho seguro no navegador:** elevar o limite de arquivo de 50 MB para **500 MB por arquivo** e o limite descomprimido de pacotes (`.zip`/OOXML) para **1 GB** (com aviso de memória/tempo acima de 100 MB), respeitando o teto prático de RAM/WASM 32-bit em navegadores.
2. **OCR local PT-BR em PDFs rasterizados e imagens (`PNG`, `JPG`, `JPEG`, `WEBP`) + limpeza de marca d'água diagonal clara:**
   - Páginas de PDF sem texto selecionável (< 20 chars) e imagens soltas passam por OCR local via **Tesseract.js WASM** (`por.traineddata.gz`, self-hosted em `/models/ocr/` e `/ocr/`, `workerBlobURL: false`, sem CDN).
   - O texto reconhecido entra no mesmo ensemble PT-BR (termos + regras + CRF + BERTimbau + NLU) e é redigido **nos pixels reais** (`mupdf` `applyRedactions(false, 2, 2, 0)` em PDF; `OffscreenCanvas` re-encode sem EXIF em imagens) com os rótulos `[nome pessoal]`, `[empresa]`, `[local]`, etc.
   - **Filtro de marca d'água clara/translúcida em páginas rasterizadas** (como a marca d'água diagonal roxo claro do PDF anexado): limpa pixels pastéis/claros sobre fundo branco preservando texto escuro e cabeçalhos escuros, com opção de ligar/desligar na UI (ligado por padrão para páginas rasterizadas).
3. **Suporte a arquivos `.zip`:**
   - Descompacta no navegador com `JSZip`, aplicando proteções de segurança contra **zip bomb** (teto de 1 GB descomprimido, máx. 5.000 entradas, taxa máxima de compressão) e **path traversal** (`..`, caminhos absolutos, symlinks).
   - Lista cada arquivo suportado (`PDF`, `DOCX`, `XLSX`, `CSV`, `PNG`, `JPG`, `WEBP`) preservando seu caminho relativo (ex.: `pasta/contrato.pdf`), ignora entradas não suportadas com aviso claro, propaga entidades entre todos os arquivos e gera download preservando a estrutura de pastas no `.zip` limpo.
4. **Controle de gastos na Cloudflare (executado diretamente via Cloudflare API MCP):**
   - Criar políticas `billing_usage_alert` em **60% do free tier do R2** (`r2_storage` = 6 GB, `r2_class_a_operations` = 600.000, `r2_class_b_operations` = 6.000.000) + `billing_budget_alert` em **\$1** para `andrealvesacioli@gmail.com`.
   - Verificar que `r2.dev` permanece desativado e documentar a trava dura de 100k req/dia do plano Workers Free (= ~30% do R2 free tier, sem cobrança automática).

## 2. Arquitetura e Restrições
- **Privacidade (`CSP connect-src 'self'`):** todos os ativos do Tesseract (`worker.min.js`, `tesseract-core-simd.wasm.js`, `tesseract-core-simd.wasm`, `por.traineddata.gz`) são baixados/copiados em `scripts/fetch-models.mjs` com **SHA-256 fixado** para `public/ocr/` e `public/models/ocr/`. Todos ficam abaixo de 25 MiB (cabem direto nos Static Assets da Cloudflare sem aumentar uso de R2!).
- **Desempenho e memória:** OCR roda sob demanda (somente quando há imagem ou página PDF sem texto), carregando o worker Tesseract de forma lazy e encerrando-o em `reset`/erro. Em PDFs com muitas páginas rasterizadas, emite progresso página a página na UI.
- **Compatibilidade:** o fluxo existente de PDF com texto, DOCX, XLSX, CSV e todos os testes unitários/E2E permanecem verdes.

## 3. Critérios de Aceitação
1. Arquivos de até **500 MB** são aceitos na UI e no Worker (acima disso rejeitados com mensagem clara); pacotes descomprimidos aceitam até **1 GB**.
2. Imagens (`PNG`, `JPG`, `JPEG`, `WEBP`) e PDFs rasterizados/escaneados (sem camada de texto) têm texto extraído por OCR local PT-BR, entidades detectadas, pixels redigidos com rótulos e metadados/EXIF removidos; marca d'água clara diagonal em páginas rasterizadas é removida quando o filtro está ativo (com toggle na UI).
3. Arquivos `.zip` são descompactados com segurança (bloqueando path traversal e zip bomb), listam os arquivos suportados mantendo caminhos relativos e geram `.zip` limpo preservando a estrutura de pastas.
4. Alertas de 60% do R2 e orçamento de \$1 estão ativos na conta Cloudflare via API, e o novo build é verificado (`typecheck`, `lint`, `test`, `build:cf`, `wrangler deploy --dry-run`) antes do deploy em produção.
