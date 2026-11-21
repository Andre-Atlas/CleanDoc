/**
 * Espelho exato de ml/common.py (token_features, cap_spans, span_features).
 * Qualquer mudança aqui exige a mesma mudança lá; o teste de paridade quebra se divergirem.
 */
import { fold } from '../core/text';

export interface Gazetteer {
  first: ReadonlySet<string>;
  last: ReadonlySet<string>;
  org: ReadonlySet<string>;
  loc: ReadonlySet<string>;
}

export interface GazetteerJson {
  first: string[];
  last: string[];
  org: string[];
  loc: string[];
}

export function toGazetteer(g: GazetteerJson): Gazetteer {
  return { first: new Set(g.first), last: new Set(g.last), org: new Set(g.org), loc: new Set(g.loc) };
}

export const PARTICLES = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);
export const COMPANY_SUFFIX = new Set(['ltda', 'ltda.', 's.a.', 's/a', 'sa', 'me', 'epp', 'eireli', 'cia', 'cia.', 'limitada']);
export const HONORIFICS = new Set(['sr.', 'sra.', 'srta.', 'dr.', 'dra.', 'prof.', 'profa.', 'eng.', 'exmo.', 'exma.', 'ilmo.', 'ilma.', 'senhor', 'senhora', 'doutor', 'doutora']);

const isAlpha = (c: string) => /\p{L}/u.test(c);
const isUpperChar = (c: string) => c !== c.toLowerCase() && c === c.toUpperCase();

export function shape(w: string): string {
  let out = '';
  for (const c of w) {
    let s: string;
    if (/\d/.test(c)) s = 'd';
    else if (isAlpha(c)) s = isUpperChar(c) ? 'X' : 'x';
    else s = c;
    if (out[out.length - 1] !== s) out += s;
  }
  return out.slice(0, 6);
}

export const isTitle = (w: string) => w.length > 0 && isAlpha(w[0]!) && isUpperChar(w[0]!);
export function isUpper(w: string): boolean {
  const letters = [...w].filter(isAlpha);
  return letters.length >= 2 && letters.every(isUpperChar);
}

export type Features = string[];

export function tokenFeatures(words: string[], i: number, gaz: Gazetteer): Features {
  const w = words[i]!;
  const f = fold(w);
  const feats = ['bias', 'w=' + f, 'suf3=' + [...f].slice(-3).join(''), 'pre2=' + [...f].slice(0, 2).join(''), 'shape=' + shape(w)];
  if (isTitle(w)) feats.push('title');
  if (isUpper(w)) feats.push('upper');
  if (/^\d+$/.test(w)) feats.push('digit');
  if (gaz.first.has(f)) feats.push('gaz_first');
  if (gaz.last.has(f)) feats.push('gaz_last');
  if (gaz.org.has(f)) feats.push('gaz_org');
  if (gaz.loc.has(f)) feats.push('gaz_loc');
  if (COMPANY_SUFFIX.has(f)) feats.push('co_suffix');
  if (HONORIFICS.has(f)) feats.push('honor');
  for (const d of [-2, -1, 1, 2]) {
    const j = i + d;
    if (j >= 0 && j < words.length) {
      const wj = words[j]!;
      feats.push(`w[${d}]=` + fold(wj));
      if (isTitle(wj)) feats.push(`title[${d}]`);
      if (Math.abs(d) === 1 && HONORIFICS.has(fold(wj))) feats.push(`honor[${d}]`);
    } else if (Math.abs(d) === 1) {
      feats.push(d < 0 ? 'BOS' : 'EOS');
    }
  }
  return feats;
}

/** Sequências maximais capitalizadas. Retorna [i, j) em índices de token. */
export function capSpans(words: string[]): [number, number][] {
  const spans: [number, number][] = [];
  let i = 0;
  const n = words.length;
  while (i < n) {
    if (isTitle(words[i]!) && !HONORIFICS.has(fold(words[i]!))) {
      let j = i + 1;
      while (j < n) {
        if (isTitle(words[j]!) || (COMPANY_SUFFIX.has(fold(words[j]!)) && j > i)) j++;
        else if (PARTICLES.has(fold(words[j]!)) && j + 1 < n && isTitle(words[j + 1]!)) j += 2;
        else break;
      }
      spans.push([i, j]);
      i = j;
    } else i++;
  }
  return spans;
}

export function spanFeatures(words: string[], i: number, j: number, gaz: Gazetteer): Features {
  const ws = words.slice(i, j);
  const fs = ws.map(fold);
  const feats = new Set<string>(['bias', 'n=' + Math.min(ws.length, 5), 'first=' + fs[0], 'last=' + fs[fs.length - 1]]);
  for (const f of fs) feats.add('w=' + f);
  for (const [d, name] of [[-1, 'prev1'], [-2, 'prev2'], [0, 'next1']] as const) {
    const k = d < 0 ? i + d : j;
    feats.add(k >= 0 && k < words.length ? `${name}=${fold(words[k]!)}` : `${name}=<none>`);
  }
  if (gaz.first.has(fs[0]!)) feats.add('gaz_first_first');
  if (gaz.last.has(fs[fs.length - 1]!)) feats.add('gaz_last_last');
  if (fs.some((f) => gaz.org.has(f))) feats.add('has_org_word');
  if (fs.some((f) => gaz.loc.has(f))) feats.add('has_loc_word');
  if (COMPANY_SUFFIX.has(fs[fs.length - 1]!)) feats.add('co_suffix');
  if (ws.every(isUpper)) feats.add('allcaps');
  if (i === 0 || ['.', ':', ';', '\n', '!', '?'].includes(words[i - 1]!)) feats.add('sent_start');
  if (i > 0 && HONORIFICS.has(fold(words[i - 1]!))) feats.add('after_honor');
  return [...feats];
}
