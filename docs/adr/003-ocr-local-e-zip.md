# ADR-003: OCR local (Tesseract WASM), filtro de marca d'água rasterizada, `.zip` e limite de 500 MB

- **Status:** Aceito
- **Data:** 2026-11-21
- **Contexto:** [ADR-001](001-processamento-no-navegador.md) e [ADR-002](002-cloudflare-workers-r2.md) estabelecem processamento 100% no navegador com `CSP connect-src 'self'`, sem persistência e deploy em Cloudflare Workers Static Assets + R2.

## Decisões

1. **Limite de tamanho de arquivo: 500 MB (1 GB descomprimido)**
   - Eleva o teto anterior de 50 MB / 400 MB até o limite seguro de memória em Web Workers/WASM 32-bit (~2 GB de heap total para buffer de entrada + MuPDF/JSZip + buffer de saída). Arquivos acima de 100 MB exibem aviso não bloqueante na UI.

2. **OCR local PT-BR com `tesseract.js` + `por.traineddata.gz` self-hosted**
   - Todos os ativos (`worker.min.js`, `tesseract-core-*.wasm(.js)` e `por.traineddata.gz` com SHA-256 fixado) são servidos pela própria origem (`/ocr/` e `/models/ocr/`), com `workerBlobURL: false` — zero CDN externa, preservando `CSP connect-src 'self'`.
   - Todos os ativos de OCR ficam abaixo de 5 MB por arquivo, cabendo direto no Cloudflare Static Assets (< 25 MiB) sem aumentar storage nem requisições no bucket R2.
   - O worker de OCR é carregado sob demanda (lazy) somente quando há imagens (`PNG`/`JPG`/`WEBP`) ou páginas PDF sem camada de texto (< 20 caracteres).

3. **Remoção de marca d'água clara/pastel em páginas rasterizadas**
   - Em PDFs rasterizados/escaneados com marca d'água diagonal em cor clara sobre fundo branco, o OCR horizontal padrão não lê texto rotacionado de baixo contraste.
   - Um filtro determinístico de pixels (`stripLightWatermark`) limpa pixels pastéis/claros de baixa saturação/alta luminosidade sobre fundo branco, preservando texto escuro e cabeçalhos escuros, com toggle acessível na interface (ligado por padrão).

4. **Suporte a `.zip` com proteção contra zip bomb e path traversal**
   - Descompacta no navegador via `JSZip`, normalizando e validando caminhos relativos (bloqueia `..`, caminhos absolutos, drives Windows e caracteres de controle), limitando entradas (5.000), tamanho descomprimido total (1 GB) e razão de compressão excessiva.
   - Os arquivos suportados extraídos entram na fila preservando o caminho relativo e são empacotados de volta mantendo a estrutura de pastas no download final.
