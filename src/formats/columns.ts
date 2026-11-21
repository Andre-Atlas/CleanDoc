import { fold } from '../core/text';
import { DEFAULT_LABEL, type Category, type Entity } from '../core/types';

/**
 * Inferência por coluna para dados tabulares (CSV/XLSX). Uma célula isolada tem pouco
 * contexto; a coluna tem muito. Duas regras:
 *  1. Cabeçalho semântico ("nome", "cliente", "razão social", "cidade"…) → toda a coluna.
 *  2. Maioria: se ≥ 50% das células não vazias da coluna têm entidade da mesma categoria,
 *     as demais células daquela coluna recebem a mesma categoria.
 */
const HEADER_RULES: [RegExp, Category, string?][] = [
  [/\b(nome|nomes|cliente|clientes|funcionari[oa]s?|colaborador(es|a)?|responsavel|paciente|alun[oa]s?|beneficiari[oa]|titular|contratante|contratad[oa]|socio|representante|solicitante|requerente|destinatari[oa]|remetente|testemunha|pai|mae|conjuge|dependente)\b/, 'pessoa'],
  [/\b(empresa|razao social|nome fantasia|fornecedor|instituicao|orgao|entidade|empregador|banco|escola|hospital|cliente pj)\b/, 'empresa'],
  [/\b(cidade|municipio|endereco|logradouro|bairro|localidade|naturalidade|local|lotacao|unidade|filial|uf|estado)\b/, 'local'],
  [/\b(e-?mail|telefone|celular|fone|whatsapp|contato)\b/, 'contato'],
  [/\b(cpf|cnpj|rg|matricula|pis|nis|cnh|passaporte|placa|registro)\b/, 'documento', '[documento]'],
  [/\b(conta|agencia|cartao|pix|iban)\b/, 'bancario'],
];

export function headerCategory(header: string): { category: Category; label: string } | null {
  const h = fold(header).replace(/[_./-]+/g, ' ');
  for (const [re, category, label] of HEADER_RULES) if (re.test(h)) return { category, label: label ?? DEFAULT_LABEL[category] };
  return null;
}

const whole = (text: string, category: Category, label: string): Entity => {
  const start = text.length - text.trimStart().length;
  const end = text.trimEnd().length;
  return { start, end, text: text.slice(start, end), category, label, detections: [{ source: 'nlu', confidence: 0.85 }], confidence: 0.85 };
};

/**
 * @param cells texto de cada segmento que pertence à coluna (índices de segmento)
 * @returns máscaras extras por índice de segmento
 */
export function inferColumn(header: string | undefined, cells: { seg: number; text: string; ents: Entity[] }[]): Map<number, Entity[]> {
  const out = new Map<number, Entity[]>();
  const filled = cells.filter((c) => c.text.trim() && !/^[-–—]+$/.test(c.text.trim()));
  if (!filled.length) return out;
  const byHeader = header ? headerCategory(header) : null;
  let target = byHeader;
  if (!target && filled.length >= 2) {
    const votes = new Map<Category, number>();
    for (const c of filled) {
      const cats = new Set(c.ents.filter((e) => e.end - e.start >= c.text.trim().length * 0.5).map((e) => e.category));
      for (const k of cats) votes.set(k, (votes.get(k) ?? 0) + 1);
    }
    const [cat, n] = [...votes].sort((a, b) => b[1] - a[1])[0] ?? [];
    if (cat && n! * 2 >= filled.length && ['pessoa', 'empresa', 'local'].includes(cat)) target = { category: cat, label: DEFAULT_LABEL[cat] };
  }
  if (!target) return out;
  for (const c of filled) {
    // célula já coberta por inteiro? mantém a detecção original
    const covered = c.ents.reduce((s, e) => s + (e.end - e.start), 0) >= c.text.trim().length * 0.9;
    if (covered) continue;
    // números em coluna de pessoa/empresa/local (ex.: código) não viram nome
    if (/^[\d.,\s/-]+$/.test(c.text.trim()) && !['documento', 'contato', 'bancario'].includes(target.category)) continue;
    out.set(c.seg, [whole(c.text, target.category, target.label)]);
  }
  return out;
}
