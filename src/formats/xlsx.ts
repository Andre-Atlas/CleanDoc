import { fold } from '../core/text';
import { DEFAULT_LABEL, type Entity } from '../core/types';
import { inferColumn } from './columns';
import { MONEY_HEADER, whole } from './csv';
import { maskText } from '../core/segments';
import { cleanName, MIME, type ParsedFile } from './types';
import { OpcPackage, openTextPart, partEdits, partSegCount, partSegments, type TextPart } from './package';
import { applyEdits, applySegmentMasks, decodeXml, encodeXml, extractSegments, removeElements, segmentEdits, type Edit, type XmlSegment } from './ooxml';
import { countByLabel } from './report';

/** Cabeçalhos de identificadores numéricos (números da coluna viram o rótulo). */
const ID_HEADER: [RegExp, string, Entity['category']][] = [
  [/\b(cpf)\b/, '[CPF]', 'documento'],
  [/\b(cnpj)\b/, '[CNPJ]', 'documento'],
  [/\b(rg|matricula|pis|nis|cnh|passaporte|titulo)\b/, '[documento]', 'documento'],
  [/\b(telefone|celular|fone|whatsapp)\b/, '[telefone]', 'contato'],
  [/\b(conta|agencia|cartao|pix)\b/, '[dado bancário]', 'bancario'],
  [/\b(cep)\b/, '[CEP]', 'local'],
];

interface NumCell { sheet: string; start: number; end: number; attrs: string; value: string; header: string; text: boolean }

export async function parseXlsx(name: string, buf: ArrayBuffer): Promise<ParsedFile> {
  const pkg = await OpcPackage.load(buf);
  const warnings: string[] = [];
  const sstPath = 'xl/sharedStrings.xml';
  const sstXml = await pkg.read(sstPath);
  const sst: XmlSegment[] = sstXml ? extractSegments(sstXml, 'si', 't', true) : [];
  const sheets = pkg.files(/^xl\/worksheets\/sheet\d+\.xml$/).sort();
  const inline: { path: string; xml: string; segs: XmlSegment[] }[] = [];
  const nums: NumCell[] = [];
  /** (aba, coluna) → cabeçalho + índices de strings compartilhadas usadas abaixo dele */
  const columns = new Map<string, { header: string; sst: Set<number> }>();
  let formulaLiterals = false;

  for (const path of sheets) {
    const xml = OpcPackage.stripTracking(await pkg.read(path));
    inline.push({ path, xml, segs: extractSegments(xml, 'is', 't') });
    const headers = new Map<string, string>();
    for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1] ?? '';
      const body = c[2] ?? '';
      const ref = /\br="([A-Z]+)(\d+)"/.exec(attrs);
      if (!ref) continue;
      const [, col, row] = ref as unknown as [string, string, string];
      const isS = /\bt="s"/.test(attrs);
      const v = /<v>([^<]*)<\/v>/.exec(body)?.[1];
      if (row === '1') {
        const t = /<t[^>]*>([^<]*)<\/t>/.exec(body)?.[1];
        const text = isS && v !== undefined ? sst[Number(v)]?.text : t ? decodeXml(t) : undefined;
        if (text) headers.set(col, text);
        continue;
      }
      if (isS && v !== undefined) {
        const key = `${path}|${col}`;
        const entry = columns.get(key) ?? { header: headers.get(col) ?? '', sst: new Set<number>() };
        entry.sst.add(Number(v));
        columns.set(key, entry);
      } else if (v !== undefined && !/\bt="(?:inlineStr|b|e)"/.test(attrs) && /^(?:<f\b[^>]*\/>|<f\b[^>]*>[^<]*<\/f>)?<v>[^<]*<\/v>$/.test(body)) {
        // números e textos de fórmula (t="str"); fórmula com atributos (shared/array) incluída
        const isText = /\bt="str"/.test(attrs);
        nums.push({ sheet: path, start: c.index ?? 0, end: (c.index ?? 0) + c[0].length, attrs, value: isText ? decodeXml(v).normalize('NFC') : v, header: headers.get(col) ?? '', text: isText });
      }
      if (/<f\b[^>]*>[^<]*"[^"<]+"/.test(body)) formulaLiterals = true;
    }
  }
  const inlineCount = inline.reduce((s, p) => s + p.segs.length, 0);
  const numBase = sst.length + inlineCount;
  // formas, caixas de texto e gráficos (títulos e caches de dados copiados das células)
  const extra: TextPart[] = [];
  for (const path of pkg.files(/^xl\/(drawings|charts)\/[^/]+\.xml$/).sort()) {
    let xml = OpcPackage.stripAttributes(OpcPackage.stripTracking(await pkg.read(path)));
    if (/^xl\/charts\//.test(path)) xml = removeElements(xml, 'c:externalData').xml;
    extra.push(openTextPart(path, xml, [['a:p', 'a:t'], ['c:pt', 'c:v']]));
  }
  const extraBase = numBase + nums.length;
  const segments = [...sst.map((s) => s.text), ...inline.flatMap((p) => p.segs.map((s) => s.text)), ...nums.map((n) => n.value), ...extra.flatMap(partSegments)];
  if (pkg.files(/^xl\/pivot(Cache|Tables)\//).length) warnings.push('Tabelas dinâmicas foram removidas: o cache delas guarda uma cópia dos dados originais. Recrie-as a partir das células limpas.');
  const workbook = await pkg.read('xl/workbook.xml');
  if (/<sheet [^>]*name="[^"]*"/.test(workbook)) warnings.push('Nomes de abas não são alterados (fórmulas dependem deles). Revise se contêm dados pessoais.');
  if (formulaLiterals) warnings.push('Há fórmulas com texto literal entre aspas; elas não são analisadas. Revise-as na planilha limpa.');
  if (pkg.files(/^xl\/externalLinks\//).length) warnings.push('A planilha tinha vínculos externos com caminhos de arquivo; eles foram removidos.');

  return {
    kind: 'xlsx',
    name,
    segments,
    warnings,
    augment(masks) {
      const out = masks.map((m) => [...m]);
      for (const { header, sst: idx } of columns.values()) {
        const cells = [...idx].filter((i) => sst[i]).map((i) => ({ seg: i, text: sst[i]!.text, ents: out[i] ?? [] }));
        for (const [seg, ents] of inferColumn(header, cells)) out[seg] = ents;
      }
      nums.forEach((n, i) => {
        const seg = numBase + i;
        if (out[seg]?.length || n.text) return;
        const h = fold(n.header);
        const id = ID_HEADER.find(([re]) => re.test(h));
        if (id) out[seg] = [whole(n.value, id[2], id[1])];
        else if (MONEY_HEADER.test(h)) out[seg] = [whole(n.value, 'valor', DEFAULT_LABEL.valor)];
      });
      return out;
    },
    async apply(masks) {
      if (sstXml) pkg.write(sstPath, applySegmentMasks(sstXml, sst, masks.slice(0, sst.length), 't'));
      let k = sst.length;
      for (const p of inline) {
        const m = masks.slice(k, (k += p.segs.length));
        const edits: Edit[] = segmentEdits(p.xml, p.segs, m, 't');
        // célula numérica mascarada vira string inline com o rótulo
        nums.forEach((n, i) => {
          const ents = masks[numBase + i] ?? [];
          if (n.sheet !== p.path || !ents.length) return;
          // célula vira string inline mascarada (a fórmula é descartada: ela recalcularia o valor original)
          const value = n.text ? maskText(n.value, ents) : ents.map((e) => e.label).join(' ');
          edits.push({ start: n.start, end: n.end, value: `<c${n.attrs.replace(/\s+t="[^"]*"/, '')} t="inlineStr"><is><t xml:space="preserve">${encodeXml(value)}</t></is></c>` });
        });
        let out = applyEdits(p.xml, edits);
        const hl = removeElements(out, 'hyperlinks');
        out = hl.xml;
        pkg.note('Hiperlinks das células', hl.count);
        pkg.write(p.path, out);
      }
      let comments = 0;
      for (const c of pkg.files(/^xl\/(comments\d*\.xml|threadedComments\/.*|persons\/.*)$/)) if (await pkg.removePart(c)) comments++;
      for (const v of pkg.files(/^xl\/drawings\/vmlDrawing\d*\.vml$/)) if (/ObjectType="Note"/.test(await pkg.read(v)) && (await pkg.removePart(v))) comments++;
      if (comments) for (const s of sheets) {
        const r = removeElements(await pkg.read(s), 'legacyDrawing');
        if (r.count) pkg.write(s, r.xml);
      }
      pkg.note('Comentários, notas e autores', comments);
      let e = extraBase;
      for (const p of extra) {
        const n = partSegCount(p);
        const xml = applyEdits(p.xml, partEdits(p, masks.slice(e, e + n)));
        e += n;
        pkg.write(p.path, xml);
      }
      for (const x of pkg.files(/^xl\/externalLinks\//)) await pkg.removePart(x);
      await pkg.removeParts(/^xl\/pivot(Cache|Tables)\//, 'Tabelas dinâmicas e cópias de dados (cache)');
      await pkg.removeParts(/^xl\/printerSettings\//, 'Configurações de impressora');
      await pkg.removeParts(/^xl\/embeddings\//, 'Objetos incorporados');
      await pkg.neutralizeExternalLinks();
      if (workbook) {
        let xml = removeElements(workbook, 'x15ac:absPath').xml;
        xml = removeElements(xml, 'pivotCaches').xml;
        xml = removeElements(xml, 'fileSharing').xml;
        xml = removeElements(xml, 'xr:revisionPtr').xml;
        pkg.write('xl/workbook.xml', OpcPackage.stripTracking(xml));
        pkg.note('Caminho do arquivo no computador do autor', /absPath/.test(workbook) ? 1 : 0);
      }
      await pkg.cleanProperties();
      await pkg.removeOrphanMedia(/^xl\/media\//);
      await pkg.stripMedia(/^xl\/media\//);
      const all = masks.flat();
      const leftover = await pkg.verify(all);
      if (leftover.length) warnings.push(`Autoverificação: um termo mascarado ainda aparece em ${leftover.join(', ')} (ex.: nome de aba ou fórmula). Revise antes de compartilhar.`);
      return {
        blob: await pkg.toBlob(MIME.xlsx),
        fileName: cleanName(name, all),
        report: { fileName: cleanName(name, all), kind: 'xlsx', entities: countByLabel(all), maskedCount: all.length, metadata: pkg.report(), watermarksRemoved: 0, warnings },
      };
    },
  };
}
