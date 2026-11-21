/** Utilidades de texto PT-BR que preservam offsets. */

const COMBINING = /[̀-ͯ]/g;

/**
 * Dobra acentos e caixa caractere a caractere, sem mudar o comprimento.
 * Permite casar "Joao" com "João" e devolver offsets do texto original.
 */
export function fold(text: string): string {
  let out = '';
  for (const ch of text) {
    const base = ch.normalize('NFD').replace(COMBINING, '').toLowerCase();
    // Mantém 1 code unit por code unit de entrada para preservar offsets.
    if (ch.length === 1) out += base.length === 1 ? base : ch.toLowerCase().slice(0, 1) || ch;
    else out += ch; // pares substitutos (emoji) passam intactos
  }
  return out;
}

export function stripAccents(s: string): string {
  return s.normalize('NFD').replace(COMBINING, '');
}

export interface Token {
  text: string;
  start: number;
  end: number;
}

/** Tokenização simples: palavras (com hífen/apóstrofo internos), números com pontuação interna e sinais isolados. */
const TOKEN_RE = /[\p{L}\p{M}]+(?:[-'’][\p{L}\p{M}]+)*\.?|\d+(?:[.,/-]\d+)*|[^\s\p{L}\p{M}\d]/gu;

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const t = m[0];
    const start = m.index ?? 0;
    // Ponto final colado só fica no token quando é abreviação conhecida (Sr., Dra., Ltda.).
    if (t.length > 1 && t.endsWith('.') && !ABBREVIATIONS.has(fold(t))) {
      tokens.push({ text: t.slice(0, -1), start, end: start + t.length - 1 });
      tokens.push({ text: '.', start: start + t.length - 1, end: start + t.length });
      continue;
    }
    tokens.push({ text: t, start, end: start + t.length });
  }
  return tokens;
}

export const ABBREVIATIONS = new Set([
  'sr.', 'sra.', 'srta.', 'dr.', 'dra.', 'prof.', 'profa.', 'eng.', 'adv.', 'exmo.', 'exma.', 'ilmo.', 'ilma.',
  'ltda.', 'cia.', 'av.', 'r.', 'n.', 'nº.', 'no.', 'pça.', 'rod.', 'est.', 'al.', 'tv.', 'me.', 'epp.', 'eireli.',
]);

/** Separadores de sentença aproximados, úteis para janelas do transformer. */
export function splitSentences(text: string, maxLen = 1500): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let start = 0;
  const re = /(?<=[.!?;:])\s+(?=[\p{Lu}\d"“(])|\n{1,}/gu;
  for (const m of text.matchAll(re)) {
    const end = m.index ?? 0;
    pushChunk(start, end);
    start = end + m[0].length;
  }
  pushChunk(start, text.length);
  return out;

  function pushChunk(s: number, e: number) {
    while (e - s > maxLen) {
      // corta no último espaço antes do limite
      let cut = text.lastIndexOf(' ', s + maxLen);
      if (cut <= s) cut = s + maxLen;
      out.push({ start: s, end: cut });
      s = cut + 1;
    }
    if (e > s && text.slice(s, e).trim()) out.push({ start: s, end: e });
  }
}

export function isCapitalized(w: string): boolean {
  return /^\p{Lu}/u.test(w);
}
