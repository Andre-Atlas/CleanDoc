import { tokenize } from '../core/text';
import type { Candidate, Category } from '../core/types';
import { capSpans, spanFeatures, tokenFeatures, type Gazetteer } from './features';

/** Camada 2: ML clássico. CRF linear-chain (Viterbi + forward-backward) e regressão logística de spans. */

export interface CrfModel {
  labels: string[];
  trans: Record<string, number>;
  state: Record<string, Record<string, number>>;
}

export interface LogRegModel {
  classes: string[];
  intercept: number[];
  coef: Record<string, number[]>;
}

const TAG_CAT: Record<string, Category> = { PES: 'pessoa', ORG: 'empresa', LOC: 'local' };

export class Crf {
  private readonly L: number;
  private readonly T: Float64Array;
  constructor(private readonly m: CrfModel) {
    this.L = m.labels.length;
    this.T = new Float64Array(this.L * this.L);
    m.labels.forEach((a, i) => m.labels.forEach((b, j) => (this.T[i * this.L + j] = m.trans[`${a}|${b}`] ?? 0)));
  }

  private emissions(feats: string[][]): Float64Array[] {
    return feats.map((fs) => {
      const e = new Float64Array(this.L);
      for (const f of fs) {
        const w = this.m.state[f];
        if (!w) continue;
        for (let k = 0; k < this.L; k++) e[k]! += w[this.m.labels[k]!] ?? 0;
      }
      return e;
    });
  }

  /** Retorna rótulos (Viterbi) e a marginal máxima por token (forward-backward). */
  tag(feats: string[][]): { labels: string[]; marg: number[]; margOf: (t: number, label: string) => number } {
    const n = feats.length;
    const L = this.L;
    if (!n) return { labels: [], marg: [], margOf: () => 0 };
    const E = this.emissions(feats);
    // Viterbi
    const dp = E.map(() => new Float64Array(L));
    const bp = E.map(() => new Int32Array(L));
    dp[0]!.set(E[0]!);
    for (let t = 1; t < n; t++)
      for (let j = 0; j < L; j++) {
        let best = -Infinity, arg = 0;
        for (let i = 0; i < L; i++) {
          const s = dp[t - 1]![i]! + this.T[i * L + j]!;
          if (s > best) { best = s; arg = i; }
        }
        dp[t]![j] = best + E[t]![j]!;
        bp[t]![j] = arg;
      }
    let last = 0;
    for (let j = 1; j < L; j++) if (dp[n - 1]![j]! > dp[n - 1]![last]!) last = j;
    const path = new Array<number>(n);
    path[n - 1] = last;
    for (let t = n - 1; t > 0; t--) path[t - 1] = bp[t]![path[t]!]!;
    // forward-backward em log
    const lse = (xs: number[]) => { const m = Math.max(...xs); return m === -Infinity ? m : m + Math.log(xs.reduce((s, x) => s + Math.exp(x - m), 0)); };
    const a = E.map(() => new Float64Array(L));
    const b = E.map(() => new Float64Array(L));
    a[0]!.set(E[0]!);
    for (let t = 1; t < n; t++) for (let j = 0; j < L; j++) a[t]![j] = E[t]![j]! + lse(Array.from({ length: L }, (_, i) => a[t - 1]![i]! + this.T[i * L + j]!));
    for (let t = n - 2; t >= 0; t--) for (let i = 0; i < L; i++) b[t]![i] = lse(Array.from({ length: L }, (_, j) => this.T[i * L + j]! + E[t + 1]![j]! + b[t + 1]![j]!));
    const Z = lse(Array.from(a[n - 1]!));
    const P = (t: number, k: number) => Math.exp(a[t]![k]! + b[t]![k]! - Z);
    const marg = Array.from({ length: n }, (_, t) => Math.max(...Array.from({ length: L }, (_, k) => P(t, k))));
    return {
      labels: path.map((k) => this.m.labels[k]!),
      marg,
      margOf: (t, label) => P(t, this.m.labels.indexOf(label)),
    };
  }
}

export class SpanClassifier {
  constructor(private readonly m: LogRegModel) {}
  proba(feats: string[]): number[] {
    const z = [...this.m.intercept];
    for (const f of feats) {
      const w = this.m.coef[f];
      if (w) for (let k = 0; k < z.length; k++) z[k]! += w[k]!;
    }
    const mx = Math.max(...z);
    const ex = z.map((v) => Math.exp(v - mx));
    const s = ex.reduce((p, c) => p + c, 0);
    return ex.map((v) => v / s);
  }
  get classes() { return this.m.classes; }
}

export interface ClassicModels {
  crf: Crf;
  span: SpanClassifier;
  gaz: Gazetteer;
}

/** Roda CRF e LogReg sobre o texto e devolve candidatos com offsets de caractere. */
export function detectClassic(text: string, models: ClassicModels): Candidate[] {
  const out: Candidate[] = [];
  // processa por linha para manter sequências curtas (planilhas e listas)
  let offset = 0;
  for (const line of text.split('\n')) {
    const toks = tokenize(line);
    if (toks.length) {
      const words = toks.map((t) => t.text);
      const { labels, margOf } = models.crf.tag(words.map((_, i) => tokenFeatures(words, i, models.gaz)));
      // spans BIO
      for (let i = 0; i < labels.length; i++) {
        const l = labels[i]!;
        if (!l.startsWith('B-') && !(l.startsWith('I-') && (i === 0 || labels[i - 1] === 'O'))) continue;
        const tag = l.slice(2);
        let j = i + 1;
        while (j < labels.length && labels[j] === `I-${tag}`) j++;
        let conf = 1;
        for (let t = i; t < j; t++) conf = Math.min(conf, margOf(t, labels[t]!));
        const cat = TAG_CAT[tag];
        if (cat) out.push({ start: offset + toks[i]!.start, end: offset + toks[j - 1]!.end, category: cat, source: 'crf', confidence: conf });
        i = j - 1;
      }
      // classificador de spans capitalizados
      for (const [i, j] of capSpans(words)) {
        const p = models.span.proba(spanFeatures(words, i, j, models.gaz));
        let k = 0;
        for (let c = 1; c < p.length; c++) if (p[c]! > p[k]!) k = c;
        const cls = models.span.classes[k]!;
        if (cls === 'none') continue;
        out.push({ start: offset + toks[i]!.start, end: offset + toks[j - 1]!.end, category: cls as Category, source: 'logreg', confidence: p[k]! });
      }
    }
    offset += line.length + 1;
  }
  return out;
}
