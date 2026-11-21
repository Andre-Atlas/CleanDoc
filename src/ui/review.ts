import { fold } from '../core/text';
import { DEFAULT_LABEL, type Category, type Entity, type UserTerm } from '../core/types';

/** Decisões do usuário na revisão. Valem para TODOS os arquivos (chave = texto dobrado). */
export interface ReviewState {
  disabled: Category[];
  excluded: string[];
  recategorized: Record<string, Category>;
}

export const emptyReview = (): ReviewState => ({ disabled: [], excluded: [], recategorized: {} });

export const entityKey = (e: Pick<Entity, 'text'>) => fold(e.text.trim());

/** Aplica categoria trocada; NÃO remove desligadas/excluídas (a UI mostra riscadas). */
export function withOverrides(entities: Entity[], review: ReviewState): Entity[] {
  return entities.map((e) => {
    const cat = review.recategorized[entityKey(e)];
    return cat && cat !== e.category ? { ...e, category: cat, label: DEFAULT_LABEL[cat] } : e;
  });
}

export function isActive(e: Entity, review: ReviewState): boolean {
  return !review.disabled.includes(e.category) && !review.excluded.includes(entityKey(e));
}

/** Entidades que serão mascaradas no arquivo final. */
export function finalEntities(entities: Entity[], review: ReviewState): Entity[] {
  return withOverrides(entities, review).filter((e) => isActive(e, review));
}

export type TermFields = Record<'pessoa' | 'empresa' | 'local' | 'outro', string[]> & { outroLabel: string };

export const emptyTerms = (): TermFields => ({ pessoa: [], empresa: [], local: [], outro: [], outroLabel: '' });

export function toUserTerms(t: TermFields, extra: UserTerm[] = []): UserTerm[] {
  const out: UserTerm[] = [];
  for (const cat of ['pessoa', 'empresa', 'local', 'outro'] as const)
    for (const text of t[cat]) out.push({ text, category: cat, label: cat === 'outro' && t.outroLabel.trim() ? t.outroLabel : undefined });
  return [...out, ...extra];
}

export const countTerms = (t: TermFields) => t.pessoa.length + t.empresa.length + t.local.length + t.outro.length;
