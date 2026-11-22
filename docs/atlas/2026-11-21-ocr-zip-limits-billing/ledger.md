# Ledger — Limite 500 MB, OCR Local, `.zip` e Controle de Gastos Cloudflare

- **Classificação:** `ATLAS · feature · arquitetura+infra+design · large → pesquisa, descoberta, plano+ADR, G1, SDD, revisão, verificação, G2 · lanes: arquitetura, design`
- **Data:** 2026-11-21

## Decisões de Descoberta
- **Marca d'água rasterizada:** OCR local PT-BR (Tesseract WASM self-hosted) + filtro de remoção de marca d'água clara/diagonal em páginas rasterizadas com opção de ligar/desligar (confirmado pelo usuário).
- **Arquivos `.zip`:** descompactar na entrada listando cada arquivo suportado com caminho relativo e entregar `.zip` limpo preservando a estrutura de pastas (confirmado pelo usuário).
- **Limite de tamanho:** 500 MB por arquivo / 1 GB descomprimido (teto seguro de RAM/WASM 32-bit em navegadores).
- **Controle de gastos Cloudflare:** criar via MCP `cloudflare_cloudflare` alertas de 60% do R2 e orçamento \$1, além de validar `r2.dev` desativado.

## Rulings (entre Gate 1 e Gate 2)
- T1 concluído via Cloudflare MCP: políticas criadas na conta `d26d9cdce225f15b0877b21627f80495` (`andrealvesacioli@gmail.com`):
  - `budget_1usd`: `b0b5c20a90f54d02a9327007802d51d9` (`billing_budget_alert`, \$1)
  - `r2_storage_60pct`: `f3e15f4fe54245fcb7ccd78a7b81e5ab` (`r2_storage >= 6`)
  - `r2_class_a_60pct`: `a2f64169d941438ba384cb0a798a9323` (`r2_class_a_operations >= 600000`)
  - `r2_class_b_60pct`: `6a0b61798ffa45df839c3ca1411ac28e` (`r2_class_b_operations >= 6000000`)
  - `r2.dev` verificado `enabled: false` no bucket `cleandoc-models`.
