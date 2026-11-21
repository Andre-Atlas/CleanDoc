# Design brief: Doc Cleaner v1

Lane Design, modo brief. Fonte da verdade visual: [Figma · Doc Cleaner](https://www.figma.com/design/yEXRB3VvfRO17jGUWVIe2I). As páginas são Tokens, Componentes, Telas — Desktop e Telas — Mobile.

## 1. Direção visual

Calma, neutra e confiável, como uma ferramenta de cartório bem-feita, não um painel de segurança.
- **Superfícies:** papel quente (`bg/canvas` #FAFAF9).
- **Acento:** um só, verde-petróleo (`accent/default` #0F766E).
- **Tipografia:** Geist para interface, Geist Mono para os rótulos de máscara.

O detalhe memorável é o **MaskChip**: o rótulo monoespaçado `[empresa]` aparece no documento no lugar do dado, com uma cor por categoria. O selo "Processado no seu dispositivo · nada é enviado" fica sempre no cabeçalho.

Evitar: ícones de cadeado e escudo em excesso, vermelho como cor de marca, gradientes, ilustrações, jargão técnico na tela principal. A palavra "modelos" aparece só no carregamento e no pipeline.

## 2. Tokens

Coleções no Figma, com code syntax `var(--…)` em cada variável:

- **Color** (modos Light/Dark):
  - `bg/canvas|surface|subtle`, `border/default|strong`, `text/primary|secondary|muted`
  - `accent/default|hover|subtle|on`
  - `status/success|warning|danger` e os respectivos `-subtle`, `focus/ring`
  - `mask/<categoria>/bg|text` para pessoa, empresa, local, valor, documento, contato, bancário e outro
- **Size:** `space/1..8` (4, 8, 12, 16, 24, 32, 48, 64) e `radius/sm|md|lg|full` (6, 10, 16, 999).
- **Estilos de texto:** display 40, title 24, heading 17, body 15, body-strong 15, caption 13, label 13, mono 13, doc 14.
- **Efeito:** `elevation/1`.

## 3. Componentes

| Componente | Variantes / propriedades | Notas |
|---|---|---|
| Button | Style = Primary/Secondary/Ghost × State = Default/Hover/Disabled; Label | altura 44 |
| Badge | Tone = Neutral/Accent/Success/Warning/Danger | status da fila |
| MaskChip | Categoria = 8 | rótulo no documento e na legenda |
| TermChip | Termo | chip removível dentro do TermInput |
| TermInput | Rótulo, Contagem | multi-termo por categoria (R7) |
| Toggle | On | — |
| CategoryToggle | Ativo; Categoria, Contagem | linha do painel de detecções |
| FileRow | Estado = Na fila/Processando/Concluído/Aviso/Erro; Nome | nome truncado com reticências |
| Dropzone | Estado = Vazio/Arrastando/Erro | múltiplos arquivos |
| AppHeader | Etapa = 1/2/3 | logo, stepper, selo |
| PrivacySeal | — | sempre visível |

## 4. Telas e estados

Desktop 1440 (`01`–`05`) e mobile 390 (`M1`–`M4`). `02` e `04` também em tema escuro.

1. **Entrada**
   - Vazio: botão desabilitado.
   - Com arquivos e termos: fila com "Na fila", painel "Termos a mascarar" aberto com 4 campos, carregamento dos modelos locais com progresso (só na primeira vez).
   - Dropzone: arrastando, formato inválido.
2. **Processamento**
   - Progresso geral e legenda do pipeline: ler → termos e regras → CRF → Transformer → NLU → metadados.
   - Linhas nos estados concluído, processando, aviso (PDF escaneado) e erro (senha).
   - "Revisar N prontos" fica habilitado antes de terminar tudo.
3. **Revisão**
   - Coluna de arquivos; preview com o segmentado Limpo/Original/Lado a lado e chips no texto.
   - Popover da detecção: original, ocorrências, fontes e confiança, "Não mascarar" e "Mudar categoria".
   - Painel com as 8 categorias e toggle, "Adicionar termo que ficou de fora", lista de metadados e marcas d'água removidos.
   - Mobile: abas Detecções/Documento.
   - Estados ainda não desenhados, para a implementação: nenhuma detecção ("Nada encontrado. Adicione termos se algo ficou de fora.") e categoria vazia (linha some).
4. **Concluído**
   - Resumo em números, download por arquivo, ZIP e relatório sem valores originais.
   - "Limpar sessão" com explicação.

## 5. Acessibilidade (WCAG 2.2 AA)

Contraste calculado no Figma (página Tokens). Todos os pares de texto passam em ambos os temas:

| Par | Claro | Escuro |
|---|---|---|
| text/primary · bg/surface | 17.07 | 15.50 |
| text/secondary · bg/surface | 6.81 | 8.21 |
| text/muted · bg/canvas | 4.50 | 5.67 |
| accent/on · accent/default | 5.47 | 7.77 |
| accent/default · accent/subtle | 4.84 | 7.62 |
| status/warning · warning-subtle | 4.51 | 8.62 |
| status/success · success-subtle | 4.57 | 8.50 |
| status/danger · danger-subtle | 5.30 | 6.08 |
| mask/* (pior caso: valor) | 6.37 | 10.34+ |

Regras para a implementação:
- `text/muted` sobre `bg/canvas` está no limite exato (4.50). Use-o só em textos de apoio e nunca sobre `bg/subtle`.
- **Alvos:**
  - O Toggle visual (36×20) não é o alvo: a linha CategoryToggle inteira (44 px) é o `<label>` clicável.
  - O × do TermChip precisa de área de toque de 24×24 no mínimo.
- **Teclado:**
  - Dropzone focável (Enter/Espaço abre o seletor).
  - TermInput: Backspace no campo vazio remove o último chip; colar uma lista cria vários chips.
  - Chips do preview navegáveis por Tab, com o popover aberto por Enter.
- A cor nunca é o único sinal: o chip sempre traz o texto da categoria e o status sempre traz ícone e texto.
- Anunciar o progresso via `aria-live="polite"`; erros por arquivo com `role="alert"`.

## 6. Achados da revisão (design-director + a11y-architect)

- MEDIUM a11y: o alvo do Toggle é menor que 24 px. Resolvido pela regra da linha inteira clicável acima.
- LOW visual: no mock do preview, a pontuação aparece separada do chip (", com sede"). Na implementação, a vírgula fica colada ao token anterior.
- LOW: estados "nenhuma detecção" e "categoria vazia" descritos acima, sem frame no Figma.
