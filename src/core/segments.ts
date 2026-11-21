import type { Entity } from './types';

/**
 * Um arquivo vira uma lista de segmentos (parágrafos, células, linhas de PDF).
 * A detecção roda no texto unido (para ter contexto e propagação); depois as
 * entidades são devolvidas a cada segmento com offsets locais.
 */
export const SEGMENT_SEP = '\n';

export function joinSegments(segments: string[]): { text: string; starts: number[] } {
  const starts: number[] = [];
  let pos = 0;
  for (const s of segments) {
    starts.push(pos);
    pos += s.length + SEGMENT_SEP.length;
  }
  return { text: segments.join(SEGMENT_SEP), starts };
}

/** Divide entidades pelos segmentos; entidade que cruza fronteira é cortada em partes. */
export function splitEntities(entities: Entity[], segments: string[], starts: number[]): Entity[][] {
  const out: Entity[][] = segments.map(() => []);
  for (const e of entities) {
    // busca binária do primeiro segmento que pode conter a entidade
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid]! <= e.start) lo = mid; else hi = mid - 1; }
    for (let i = lo; i < segments.length && starts[i]! < e.end; i++) {
      const s0 = starts[i]!;
      const s1 = s0 + segments[i]!.length;
      const a = Math.max(e.start, s0);
      const b = Math.min(e.end, s1);
      if (b > a) out[i]!.push({ ...e, start: a - s0, end: b - s0, text: segments[i]!.slice(a - s0, b - s0) });
    }
  }
  return out;
}

/** Substitui cada entidade pelo seu rótulo. Entidades devem estar ordenadas e sem sobreposição. */
export function maskText(text: string, entities: Entity[]): string {
  let out = '';
  let pos = 0;
  for (const e of [...entities].sort((a, b) => a.start - b.start)) {
    // sobreposição parcial: o rótulo anterior cobre a união (nada do original sobra)
    if (e.start < pos) { pos = Math.max(pos, e.end); continue; }
    out += text.slice(pos, e.start) + e.label;
    pos = e.end;
  }
  return out + text.slice(pos);
}
