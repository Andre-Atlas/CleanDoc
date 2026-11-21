import type { Candidate, Entity, UserTerm } from '../core/types';
import { detectClassic, type ClassicModels } from './crf';
import { fuse, DEFAULT_THRESHOLD } from './fuse';
import { detectNlu, propagate, propagationKeys } from './nlu';
import { detectRules } from './rules';
import { detectTransformer, type WordClassifier } from './transformer';
import { detectUserTerms } from './userTerms';

export interface DetectContext {
  terms: UserTerm[];
  classic?: ClassicModels;
  ner?: WordClassifier;
  threshold?: number;
  /** chamada a cada etapa por texto, para a barra de progresso */
  onStage?: (stage: Stage, index: number) => void;
}

export type Stage = 'termos' | 'regras' | 'crf' | 'transformer' | 'nlu';

/**
 * Detecta entidades em vários textos (um ou mais arquivos) com propagação entre eles:
 * uma entidade aceita em qualquer texto é mascarada em todas as ocorrências de todos os textos.
 */
export async function detectAll(texts: string[], ctx: DetectContext): Promise<Entity[][]> {
  const threshold = ctx.threshold ?? DEFAULT_THRESHOLD;
  const base: Candidate[][] = [];
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i]!;
    const c: Candidate[] = [];
    ctx.onStage?.('termos', i);
    c.push(...detectUserTerms(text, ctx.terms));
    ctx.onStage?.('regras', i);
    c.push(...detectRules(text));
    if (ctx.classic) {
      ctx.onStage?.('crf', i);
      c.push(...detectClassic(text, ctx.classic));
    }
    if (ctx.ner) {
      ctx.onStage?.('transformer', i);
      c.push(...(await detectTransformer(text, ctx.ner)));
    }
    ctx.onStage?.('nlu', i);
    c.push(...detectNlu(text, ctx.classic?.gaz.first));
    base.push(c);
  }
  const first = texts.map((t, i) => fuse(t, base[i]!, threshold));
  const keys = propagationKeys(first.flat());
  return texts.map((t, i) => fuse(t, [...base[i]!, ...propagate(t, keys)], threshold));
}
