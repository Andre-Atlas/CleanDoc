import Papa from 'papaparse';
import { maskText } from '../core/segments';
import { fold } from '../core/text';
import { DEFAULT_LABEL, type Entity } from '../core/types';
import { inferColumn } from './columns';
import { cleanName, MIME, type ParsedFile } from './types';
import { countByLabel } from './report';

export const MONEY_HEADER = /\b(salario|valor|preco|total|remuneracao|renda|custo|pagamento|saldo|receita|faturamento|honorarios|bonus|comissao|desconto|limite|divida|debito|credito)\b/;
const NUMERIC = /^-?[\d.,\s]+$/;

/** CSV: cada célula é um segmento. Delimitador detectado automaticamente; BOM e quebras preservados. */
export async function parseCsv(name: string, buf: ArrayBuffer): Promise<ParsedFile> {
  // UTF-8 estrito; se falhar, Windows-1252 (CSV salvo pelo Excel em português)
  let text: string;
  let legacy = false;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder('windows-1252').decode(buf);
    legacy = true;
  }
  text = text.normalize('NFC');
  const bom = text.startsWith('\uFEFF');
  if (bom) text = text.slice(1);
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: false });
  const rows = parsed.data;
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  // índice de segmento de cada célula
  const segOf: number[][] = [];
  let n = 0;
  for (const row of rows) segOf.push(row.map(() => n++));
  const cells = rows.flat();
  const header = rows[0] ?? [];

  return {
    kind: 'csv',
    name,
    segments: cells,
    warnings: [
      ...(parsed.errors.length ? ['O CSV tem linhas irregulares; revise o resultado.'] : []),
      ...(legacy ? ['CSV em Windows-1252 (Excel). O arquivo limpo é salvo em UTF-8.'] : []),
    ],
    augment(masks) {
      const out = masks.map((m) => [...m]);
      const ncol = Math.max(0, ...rows.map((r) => r.length));
      for (let c = 0; c < ncol; c++) {
        const col = rows.slice(1).map((row, r) => ({ seg: segOf[r + 1]![c]!, text: row[c] ?? '' })).filter((x) => x.seg !== undefined);
        const h = header[c] ?? '';
        if (MONEY_HEADER.test(fold(h))) {
          for (const x of col) if (NUMERIC.test(x.text.trim()) && x.text.trim() && !out[x.seg]!.length) out[x.seg] = [whole(x.text, 'valor', DEFAULT_LABEL.valor)];
          continue;
        }
        for (const [seg, ents] of inferColumn(h, col.map((x) => ({ ...x, ents: out[x.seg] ?? [] })))) out[seg] = ents;
      }
      return out;
    },
    async apply(masks) {
      let i = 0;
      const out = rows.map((row) => row.map((cell) => maskText(cell, masks[i++] ?? [])));
      // UTF-8 com BOM quando a origem era Windows-1252 (o Excel abre com acentos); fórmulas (=, +, @) escapadas
      const csv = (bom || legacy ? '\uFEFF' : '') + Papa.unparse(out, { delimiter: parsed.meta.delimiter, newline, escapeFormulae: /^[=+@\t\r]/ });
      const all = masks.flat();
      return {
        blob: new Blob([csv], { type: MIME.csv + ';charset=utf-8' }),
        fileName: cleanName(name, all),
        report: { fileName: cleanName(name, all), kind: 'csv', entities: countByLabel(all), maskedCount: all.length, metadata: [], watermarksRemoved: 0, warnings: [] },
      };
    },
  };
}

export function whole(text: string, category: Entity['category'], label: string): Entity {
  const start = text.length - text.trimStart().length;
  const end = text.trimEnd().length;
  return { start, end, text: text.slice(start, end), category, label, detections: [{ source: 'regra', confidence: 0.9 }], confidence: 0.9 };
}
