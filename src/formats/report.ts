import type { Category, Entity } from '../core/types';

export interface CategoryCount {
  category: Category;
  label: string;
  count: number;
}

/** Contagem por rótulo, sem valores originais (o relatório nunca guarda o texto mascarado). */
export function countByLabel(entities: Entity[]): CategoryCount[] {
  const m = new Map<string, CategoryCount>();
  for (const e of entities) {
    const k = `${e.category}|${e.label}`;
    const c = m.get(k) ?? { category: e.category, label: e.label, count: 0 };
    c.count++;
    m.set(k, c);
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}
