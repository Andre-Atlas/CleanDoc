import { fold } from '../core/text';
import type { Candidate, Category, UserTerm } from '../core/types';
import { DEFAULT_LABEL } from '../core/types';

/** Camada 0: termos informados pelo usuário, com variações. Prioridade máxima. */

const PARTICLES = new Set(['da', 'de', 'do', 'das', 'dos', 'e', 'di', 'du', 'del']);
const COMPANY_SUFFIX = /\s*,?\s*\b(?:ltda\.?|s\.?\/?a\.?|s\/a|me|epp|eireli|cia\.?|limitada|sociedade anônima)\s*$/i;

/** Gera variações de um termo conforme a categoria. Retorna strings já dobradas (sem acento, minúsculas). */
export function termVariants(term: UserTerm): string[] {
  const raw = term.text.trim().replace(/\s+/g, ' ');
  if (!raw) return [];
  const v = new Set<string>([raw]);
  if (term.category === 'pessoa') {
    const parts = raw.replace(/^(?:sr|sra|dr|dra|prof|profa)\.?\s+/i, '').split(' ');
    const names = parts.filter((p) => !PARTICLES.has(p.toLowerCase()));
    v.add(parts.join(' '));
    if (names.length >= 2) {
      const first = names[0]!;
      const last = names[names.length - 1]!;
      v.add(`${first} ${last}`);
      // Sobrenome e primeiro nome isolados só quando não são curtos demais (evita "Sá", "Li").
      if (last.length >= 4) v.add(last);
      if (first.length >= 4) v.add(first);
      v.add(`${first[0]}. ${last}`);
      v.add(`${first[0]}.${last}`);
      v.add(names.map((n, i) => (i < names.length - 1 ? `${n[0]}.` : n)).join(' '));
      v.add(`${last}, ${first}`);
    }
  }
  if (term.category === 'empresa') {
    const base = raw.replace(COMPANY_SUFFIX, '').trim();
    if (base.length >= 3) v.add(base);
    // sigla das iniciais (Construtora Alfa Brasil → CAB) só se ≥ 3 palavras com maiúscula
    const caps = base.split(' ').filter((w) => /^\p{Lu}/u.test(w));
    if (caps.length >= 3) v.add(caps.map((w) => w[0]).join(''));
  }
  return [...v].map(fold).filter((s) => s.length >= 2);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function detectUserTerms(text: string, terms: UserTerm[]): Candidate[] {
  if (!terms.length) return [];
  const folded = fold(text);
  const out: Candidate[] = [];
  for (const term of terms) {
    const variants = termVariants(term).sort((a, b) => b.length - a.length);
    if (!variants.length) continue;
    const pattern = variants.map((s) => escapeRe(s).replace(/\\\.\s*|\s+/g, (m) => (m.startsWith('\\.') ? '\\.[^\\S\\n]*' : '[^\\S\\n]+'))).join('|');
    const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, 'gu');
    for (const m of folded.matchAll(re)) {
      const start = m.index ?? 0;
      out.push({
        start,
        end: start + m[0].length,
        category: term.category,
        label: labelFor(term),
        source: 'termo',
        confidence: m[0] === variants[0] ? 1 : 0.97,
      });
    }
  }
  return out;
}

export function labelFor(term: UserTerm): string {
  if (term.label?.trim()) {
    const l = term.label.trim();
    return l.startsWith('[') ? l : `[${l}]`;
  }
  return DEFAULT_LABEL[term.category as Category];
}
