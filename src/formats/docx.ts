import { cleanName, MIME, type ParsedFile } from './types';
import { OpcPackage, openTextPart, partEdits, partSegCount, partSegments, type TextPart } from './package';
import { applyEdits, removeElements, unwrapElements } from './ooxml';
import { countByLabel } from './report';

/** Todas as partes XML de word/ com conteúdo; ficam de fora só as puramente estruturais. */
const TEXT_PARTS = /^word\/(?!(?:styles|stylesWithEffects|fontTable|numbering|settings|webSettings|theme\/|glossary\/|comments|people)).+\.xml$/;
const COMMENT_PARTS = /^word\/(comments|commentsExtended|commentsIds|commentsExtensible|people)\.xml$/;
const WATERMARK = /PowerPlusWaterMarkObject|WaterMark|Watermark|v:textpath/;

export async function parseDocx(name: string, buf: ArrayBuffer): Promise<ParsedFile> {
  const pkg = await OpcPackage.load(buf);
  const warnings: string[] = [];
  const parts: TextPart[] = [];
  let watermarks = 0;
  const bookmarks = new Map<string, string>();
  for (const path of pkg.files(TEXT_PARTS).sort()) {
    let xml = await pkg.read(path);
    // Aceita revisões: texto excluído sai, inserido fica. Comentários saem do corpo.
    const del = removeElements(xml, 'w:del');
    const mv = removeElements(del.xml, 'w:moveFrom');
    xml = unwrapElements(unwrapElements(mv.xml, 'w:ins'), 'w:moveTo');
    pkg.note('Histórico de revisões (alterações controladas)', del.count + mv.count);
    for (const t of ['w:commentRangeStart', 'w:commentRangeEnd', 'w:commentReference', 'w:moveFromRangeStart', 'w:moveFromRangeEnd', 'w:moveToRangeStart', 'w:moveToRangeEnd', 'w:permStart', 'w:permEnd'])
      xml = removeElements(xml, t).xml;
    // propriedades alteradas com autor/data e códigos de campo (HYPERLINK "mailto:…")
    for (const t of ['w:rPrChange', 'w:pPrChange', 'w:sectPrChange', 'w:tblPrChange', 'w:trPrChange', 'w:tcPrChange', 'w:tblGridChange', 'w:numberingChange']) xml = removeElements(xml, t).xml;
    xml = xml.replace(/(<w:instrText\b[^>]*>)[^<]*(<\/w:instrText>)/g, (_m, a: string, b: string) => `${a} ${b}`);
    xml = xml.replace(/(<w:fldSimple\b[^>]*\sw:instr=")[^"]*"/g, '$1"');
    // nomes de marcadores viram bm1, bm2… (as âncoras internas são reescritas igual)
    xml = xml.replace(/(<w:bookmarkStart\b[^>]*\sw:name=")([^"]*)"/g, (_m, a: string, n: string) => {
      if (!bookmarks.has(n)) bookmarks.set(n, n.startsWith('_') ? n : `bm${bookmarks.size + 1}`);
      return `${a}${bookmarks.get(n)}"`;
    });
    xml = OpcPackage.stripAttributes(OpcPackage.stripTracking(xml));
    // gráficos: o vínculo com a planilha incorporada sai (ela é removida); o cache já mascarado continua desenhando
    if (/^word\/charts\//.test(path)) xml = removeElements(xml, 'c:externalData').xml;
    if (/^word\/header/.test(path)) {
      const a = removeElements(xml, 'w:pict', (el) => WATERMARK.test(el));
      const b = removeElements(a.xml, 'w:drawing', (el) => WATERMARK.test(el));
      const c = removeElements(b.xml, 'w:sdt', (el) => /docPartGallery w:val="Watermarks"/.test(el));
      xml = c.xml;
      watermarks += a.count + b.count + c.count;
    }
    parts.push(openTextPart(path, xml));
  }
  // âncoras de hiperlinks internos seguem os marcadores renomeados
  for (const p of parts) p.xml = p.xml.replace(/(\sw:anchor=")([^"]*)"/g, (_m, a: string, n: string) => `${a}${bookmarks.get(n) ?? ''}"`);
  // reabre após renomear âncoras (offsets precisam ser do XML final)
  for (let i = 0; i < parts.length; i++) parts[i] = openTextPart(parts[i]!.path, parts[i]!.xml);
  if (!parts.some((p) => p.path === 'word/document.xml')) throw new Error('DOCX sem word/document.xml');
  if (pkg.files(/^word\/embeddings\//).length) warnings.push('Objetos incorporados (planilhas, apresentações) foram removidos: não é possível analisá-los. Gráficos mantêm a imagem e os rótulos já mascarados.');
  const segments = parts.flatMap(partSegments);

  return {
    kind: 'docx',
    name,
    segments,
    warnings,
    async apply(masks) {
      let k = 0;
      for (const p of parts) {
        const n = partSegCount(p);
        const xml = applyEdits(p.xml, partEdits(p, masks.slice(k, k + n)));
        k += n;
        pkg.write(p.path, xml);
        await pkg.pruneRels(p.path, xml);
      }
      let comments = 0;
      for (const c of pkg.files(COMMENT_PARTS)) if (await pkg.removePart(c)) comments++;
      pkg.note('Comentários e autores de comentários', comments);
      await pkg.removeParts(/^word\/embeddings\//, 'Objetos incorporados');
      await pkg.removeParts(/^word\/glossary\//, 'Blocos de construção (glossário)');
      const settings = await pkg.read('word/settings.xml');
      if (settings) {
        let xml = removeElements(settings, 'w:rsids').xml;
        xml = removeElements(xml, 'w:attachedTemplate').xml;
        xml = removeElements(xml, 'w:mailMerge').xml;
        const dv = removeElements(xml, 'w:docVars');
        pkg.write('word/settings.xml', dv.xml);
        pkg.note('Variáveis, mala direta e modelo anexado', dv.count + 1);
      }
      await pkg.neutralizeExternalLinks();
      await pkg.cleanProperties();
      await pkg.removeOrphanMedia(/^word\/media\//);
      await pkg.stripMedia(/^word\/media\//);
      if (watermarks) pkg.note('Marca d\'água', watermarks);
      const all = masks.flat();
      const leftover = await pkg.verify(all);
      if (leftover.length) warnings.push(`Autoverificação: um termo mascarado ainda aparece em ${leftover.join(', ')}. Revise antes de compartilhar.`);
      return {
        blob: await pkg.toBlob(MIME.docx),
        fileName: cleanName(name, all),
        report: { fileName: cleanName(name, all), kind: 'docx', entities: countByLabel(all), maskedCount: all.length, metadata: pkg.report(), watermarksRemoved: watermarks, warnings },
      };
    },
  };
}
