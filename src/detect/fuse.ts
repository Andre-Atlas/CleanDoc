import type { Candidate, Category, Entity } from '../core/types';
import { DEFAULT_LABEL, HIGH_PRECISION_SOURCES } from '../core/types';
import { fold } from '../core/text';

/**
 * Fusão das camadas. Candidatos sobrepostos viram um grupo; o grupo vira uma entidade
 * com a união dos trechos. A categoria vem da fonte de alta precisão, se houver; senão,
 * da maior confiança combinada. Grupos só com fontes estatísticas passam se a
 * confiança combinada ≥ limiar (baixo de propósito: privilegia recall).
 */
export const DEFAULT_THRESHOLD = 0.4;

const PRIORITY: Record<Category, number> = {
  documento: 8, bancario: 7, contato: 6, valor: 5, pessoa: 4, empresa: 3, local: 2, outro: 1,
};

export function fuse(text: string, candidates: Candidate[], threshold = DEFAULT_THRESHOLD): Entity[] {
  const sorted = candidates
    .filter((c) => c.end > c.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const groups: Candidate[][] = [];
  let cur: Candidate[] = [];
  let curEnd = -1;
  for (const c of sorted) {
    if (cur.length && c.start < curEnd) {
      cur.push(c);
      curEnd = Math.max(curEnd, c.end);
    } else {
      if (cur.length) groups.push(cur);
      cur = [c];
      curEnd = c.end;
    }
  }
  if (cur.length) groups.push(cur);

  const out: Entity[] = [];
  const passes = (e: Entity) => e.detections.some((d) => HIGH_PRECISION_SOURCES.has(d.source)) || e.confidence >= threshold;
  for (const g of groups) {
    const e = resolve(text, g);
    if (!e) continue;
    if (!e.detections.some((d) => HIGH_PRECISION_SOURCES.has(d.source)) && isStructural(e.text)) continue;
    if (passes(e)) out.push(e);
    // Sobras: candidatos de outra categoria que passam além da entidade escolhida
    // (ex.: "Porto Velho/GO" local × "GO da Prefeitura…" empresa) viram entidades próprias.
    for (const side of ['left', 'right'] as const) {
      const rest = g
        .filter((c) => (side === 'left' ? c.start < e.start : c.end > e.end))
        .map((c) => ({ ...c, start: side === 'left' ? c.start : Math.max(c.start, e.end), end: side === 'left' ? Math.min(c.end, e.start) : c.end }));
      // só vale se a sobra for a maior parte do candidato original (evita restos como "CPF ")
      const trimmed = rest
        .map((c, k) => ({ c: trim(text, c), orig: g.filter((x) => (side === 'left' ? x.start < e.start : x.end > e.end))[k]! }))
        .filter(({ c, orig }) => c.end - c.start >= 2 && (c.end - c.start) * 2 >= orig.end - orig.start)
        .map(({ c }) => c);
      if (!trimmed.length) continue;
      const r = resolve(text, trimmed);
      if (r && passes(r)) out.push(r);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function trim(text: string, c: Candidate): Candidate {
  let { start, end } = c;
  while (start < end && /[\s/,;:.()\-–]/.test(text[start]!)) start++;
  while (end > start && /[\s/,;:(\-–]/.test(text[end - 1]!)) end--;
  return { ...c, start, end };
}

function combine(confs: number[]): number {
  return 1 - confs.reduce((p, c) => p * (1 - Math.min(0.999, Math.max(0, c))), 1);
}

function resolve(text: string, g: Candidate[]): Entity | null {
  const high = g.filter((c) => HIGH_PRECISION_SOURCES.has(c.source));
  // Se houver alta precisão, ela define o trecho (evita que o modelo "engorde" um CPF).
  const pool = high.length ? high : g;
  // Termo do usuário vence regra; dentro da mesma fonte, o mais longo vence.
  const byCat = new Map<Category, Candidate[]>();
  for (const c of pool) byCat.set(c.category, [...(byCat.get(c.category) ?? []), c]);
  let best: { cat: Category; score: number } | null = null;
  for (const [cat, cs] of byCat) {
    const userBoost = cs.some((c) => c.source === 'termo') ? 10 : 0;
    const score = userBoost + combine(cs.map((c) => c.confidence)) + PRIORITY[cat] / 100;
    if (!best || score > best.score) best = { cat, score };
  }
  if (!best) return null;
  const chosen = byCat.get(best.cat)!;
  // Trecho: união dos candidatos da categoria escolhida + estatísticos que se sobrepõem a ela (recall).
  let start = Math.min(...chosen.map((c) => c.start));
  let end = Math.max(...chosen.map((c) => c.end));
  if (!high.length) {
    // Só fontes estatísticas: o trecho é a união do grupo inteiro (recall > fronteira exata).
    // Ex.: "Renato Siqueira" (pessoa, NLU) × "Siqueira" (empresa, CRF) → mascara os dois nomes.
    for (const c of g) { start = Math.min(start, c.start); end = Math.max(end, c.end); }
  }
  const labelSrc = chosen.find((c) => c.source === 'termo' && c.label) ?? chosen.find((c) => c.label);
  const sameCat = g.filter((c) => c.category === best!.cat);
  const detections = dedupeSources(sameCat);
  return {
    start,
    end,
    text: text.slice(start, end),
    category: best.cat,
    label: labelSrc?.label ?? DEFAULT_LABEL[best.cat],
    detections,
    confidence: high.length ? Math.max(...high.map((c) => c.confidence)) : combine(detections.map((d) => d.confidence)),
  };
}

function dedupeSources(cs: Candidate[]) {
  const m = new Map<string, number>();
  for (const c of cs) m.set(c.source, Math.max(m.get(c.source) ?? 0, c.confidence));
  return [...m].map(([source, confidence]) => ({ source: source as Candidate['source'], confidence }));
}

/** Palavras de estrutura de documento: títulos como "CONTRATO DE PRESTAÇÃO DE SERVIÇOS" não são entidades. */
const STRUCTURAL = new Set(('contrato prestacao servicos servico clausula paragrafo unico termo aditivo anexo ata reuniao relatorio procuracao declaracao ' +
  'recibo nota fiscal proposta comercial tecnica orcamento objeto partes condicoes gerais disposicoes finais vigencia rescisao foro ' +
  'pagamento valor prazo multa obrigacoes contratante contratada contratado locacao compra venda instrumento particular publico ' +
  'acordo confidencialidade sigilo memorando oficio circular edital laudo parecer ficha cadastro cadastral dados pessoais resumo ' +
  'primeira segunda terceira quarta quinta sexta setima oitava nona decima de da do das dos e para com sem por em no na nos nas o a os as ' +
  'i ii iii iv v vi vii viii ix x total item itens descricao quantidade observacoes obs').split(' '));

export function isStructural(text: string): boolean {
  const words = fold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.length > 0 && words.every((w) => STRUCTURAL.has(w));
}
