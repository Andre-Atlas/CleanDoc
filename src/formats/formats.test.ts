import JSZip from 'jszip';
import { joinSegments, splitEntities } from '../core/segments';
import { detectAll } from '../detect/pipeline';
import type { ParsedFile } from './types';
import { parseCsv } from './csv';
import { parsePdf } from './pdf';
import { parseXlsx } from './xlsx';
import { parseDocx } from './docx';

async function clean(doc: ParsedFile) {
  const { text, starts } = joinSegments(doc.segments);
  const [ents] = await detectAll([text], { terms: [{ text: 'Marcos Vinícius Prado', category: 'pessoa' }] });
  const per = splitEntities(ents!, doc.segments, starts);
  return doc.apply(doc.augment ? doc.augment(per) : per);
}

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe('XLSX', () => {
  it('mascara strings compartilhadas, CPF numérico, coluna de salário e remove comentários/caminho', async () => {
    const z = new JSZip();
    z.file('[Content_Types].xml', '<Types><Override PartName="/xl/comments1.xml" ContentType="c"/></Types>');
    z.file('xl/workbook.xml', '<workbook><mc:AlternateContent><mc:Choice><x15ac:absPath url="C:\\Users\\marcos.prado\\Desktop\\"/></mc:Choice></mc:AlternateContent><sheets><sheet name="Folha" sheetId="1"/></sheets></workbook>');
    z.file('xl/sharedStrings.xml', '<sst><si><t>Nome</t></si><si><t>CPF</t></si><si><t>Salário</t></si><si><t>Marcos Vinícius Prado</t></si><si><r><t>ana@</t></r><r><t>empresa.com.br</t></r></si></sst>');
    z.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>52998224725</v></c><c r="C2" s="3"><v>8500.5</v></c><c r="D2" t="s"><v>4</v></c></row></sheetData><legacyDrawing r:id="rId1"/></worksheet>');
    z.file('xl/worksheets/_rels/sheet1.xml.rels', '<Relationships><Relationship Id="rId2" Target="../comments1.xml"/><Relationship Id="rId1" Target="../drawings/vmlDrawing1.vml"/></Relationships>');
    z.file('xl/comments1.xml', '<comments><authors><author>Marcos Prado</author></authors></comments>');
    z.file('xl/drawings/vmlDrawing1.vml', '<xml><x:ClientData ObjectType="Note"/></xml>');
    z.file('docProps/core.xml', '<cp:coreProperties><dc:creator>Marcos Prado</dc:creator></cp:coreProperties>');
    const res = await clean(await parseXlsx('folha.xlsx', await z.generateAsync({ type: 'arraybuffer' })));
    const out = await JSZip.loadAsync(await res.blob.arrayBuffer());
    const all = (await Promise.all(Object.keys(out.files).map((p) => out.file(p)?.async('string') ?? ''))).join('\n');
    for (const s of ['Marcos', '52998224725', '8500.5', 'ana@', 'empresa.com.br', 'marcos.prado']) expect(all, s).not.toContain(s);
    const sheet = await out.file('xl/worksheets/sheet1.xml')!.async('string');
    expect(sheet).toContain('<c r="B2" t="inlineStr"><is><t xml:space="preserve">[CPF]</t></is></c>');
    expect(sheet).toContain('<c r="C2" s="3" t="inlineStr"><is><t xml:space="preserve">[valor]</t></is></c>');
    expect(sheet).not.toContain('legacyDrawing');
    expect(out.file('xl/comments1.xml')).toBeNull();
    expect(res.report.warnings.join()).toContain('abas');
  });
});

describe('CSV', () => {
  it('preserva delimitador e BOM, mascara células e coluna de valor', async () => {
    const csv = '\uFEFFnome;cpf;valor;obs\r\nMarcos Vinícius Prado;529.982.247-25;1200,50;ligar (61) 99876-5432\r\n';
    const res = await clean(await parseCsv('lista.csv', enc(csv)));
    const out = await res.blob.text();
    expect(out.startsWith('\uFEFF') || out.startsWith('nome')).toBe(true);
    expect(out).toContain('nome;cpf;valor;obs\r\n');
    expect(out).toContain('[nome pessoal];[CPF];[valor];ligar [telefone]');
  });
  it('inferência por coluna: cabeçalho "nome" mascara nomes que os modelos não pegaram', async () => {
    const res = await clean(await parseCsv('equipe.csv', enc('nome,cidade,obs\nRenato Siqueira,Anápolis,ok\nXyzw Qwerty,Goiânia,-\n')));
    const out = await res.blob.text();
    for (const s of ['Renato', 'Siqueira', 'Xyzw', 'Qwerty', 'Anápolis', 'Goiânia']) expect(out, s).not.toContain(s);
    expect(out).toContain('ok');
  });
});

describe('PDF', () => {
  function makePdf(): ArrayBuffer {
    const content = 'BT /F1 12 Tf 72 720 Td (Contratante: Marcos Vinicius Prado, CPF 529.982.247-25.) Tj ET\n/Artifact <</Type /Pagination /Subtype /Watermark>> BDC BT /F1 40 Tf 100 400 Td (CONFIDENCIAL) Tj ET EMC';
    const objs = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      '<< /Author (Marcos Prado) /Producer (Word) /Title (Contrato Marcos) >>',
    ];
    let s = '%PDF-1.7\n';
    const offs: number[] = [];
    objs.forEach((o, i) => { offs.push(s.length); s += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const x = s.length;
    s += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
    s += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${x}\n%%EOF`;
    return enc(s);
  }

  it('redação real, rótulo desenhado, marca d\'água e Info removidos', async () => {
    const doc = await parsePdf('contrato.pdf', makePdf());
    expect(doc.segments.join(' ')).toContain('Marcos Vinicius Prado');
    const res = await clean(doc);
    // reabre e extrai o texto: o original não pode existir
    const mupdf = await import('mupdf');
    const back = mupdf.Document.openDocument(new Uint8Array(await res.blob.arrayBuffer()), 'application/pdf');
    const txt = back.loadPage(0).toStructuredText('preserve-whitespace').asText();
    expect(txt).not.toContain('Marcos');
    expect(txt).not.toContain('529.982');
    expect(txt).not.toContain('CONFIDENCIAL');
    expect(txt).toContain('[nome pessoal]');
    expect(txt).toContain('[CPF]');
    expect(back.getMetaData('info:Author') ?? '').toBe('');
    expect(res.report.watermarksRemoved).toBeGreaterThan(0);
  });
});

describe('regressões da revisão (formatos)', () => {
  it('XLSX: t="str", fórmula compartilhada, <si> vazio e hiperlinks', async () => {
    const z = new JSZip();
    z.file('[Content_Types].xml', '<Types/>');
    z.file('xl/workbook.xml', '<workbook><sheets><sheet name="A" sheetId="1"/></sheets></workbook>');
    z.file('xl/sharedStrings.xml', '<sst><si><t>Nome</t></si><si><t/></si><si><t>Marcos Vinícius Prado</t></si><si><t>Joana Alves</t></si></sst>');
    z.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><f>X</f><v>52998224725</v></c><c r="C2" t="str"><f>CONCAT(A2)</f><v>Marcos Vinícius Prado</v></c></row>' +
      '<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><f t="shared" ref="B3:B4" si="0">B2</f><v>52998224725</v></c></row></sheetData>' +
      '<hyperlinks><hyperlink ref="A2" r:id="rId9" display="marcos.prado@acme.com"/></hyperlinks></worksheet>');
    z.file('xl/worksheets/_rels/sheet1.xml.rels', '<Relationships><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="mailto:marcos.prado@acme.com" TargetMode="External"/></Relationships>');
    const res = await clean(await parseXlsx('p.xlsx', await z.generateAsync({ type: 'arraybuffer' })));
    const out = await JSZip.loadAsync(await res.blob.arrayBuffer());
    const all = (await Promise.all(Object.keys(out.files).map((p) => out.file(p)?.async('string') ?? ''))).join('\n');
    for (const s of ['Marcos', 'Joana', '52998224725', 'acme.com']) expect(all, s).not.toContain(s);
  });
  it('DOCX: hyperlink mailto, campo HYPERLINK, autor em rPrChange e texto NFD', async () => {
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const z = new JSZip();
    z.file('[Content_Types].xml', '<Types/>');
    z.file('word/document.xml', `<w:document ${W}><w:body><w:p><w:r><w:rPr><w:rPrChange w:id="1" w:author="Carlos Lima" w:date="2025-01-01T00:00:00Z"><w:rPr/></w:rPrChange></w:rPr><w:t>Contato</w:t></w:r>` +
      '<w:r><w:instrText> HYPERLINK "mailto:carlos.lima@acme.com" </w:instrText></w:r><w:hyperlink r:id="rId5"><w:r><w:t>carlos.lima@acme.com</w:t></w:r></w:hyperlink></w:p>' +
      `<w:p><w:r><w:t>${'José Prado'.normalize('NFD')} assina.</w:t></w:r></w:p></w:body></w:document>`);
    z.file('word/_rels/document.xml.rels', '<Relationships><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="mailto:carlos.lima@acme.com" TargetMode="External"/></Relationships>');
    const doc = await parseDocx('d.docx', await z.generateAsync({ type: 'arraybuffer' }));
    const { text, starts } = joinSegments(doc.segments);
    const [ents] = await detectAll([text], { terms: [{ text: 'José Prado', category: 'pessoa' }] });
    const res = await doc.apply(splitEntities(ents!, doc.segments, starts));
    const out = await JSZip.loadAsync(await res.blob.arrayBuffer());
    const all = (await Promise.all(Object.keys(out.files).map((p) => out.file(p)?.async('string') ?? ''))).join('\n');
    for (const s of ['carlos.lima', 'Carlos Lima', 'acme.com', 'Prado', 'Jose']) expect(all, s).not.toContain(s);
  });
});

describe('regressões da revisão de segurança (PDF)', () => {
  it('anotações, marcadores, texto fora da página e camada de marca d\'água não sobrevivem', async () => {
    const content = 'BT /F1 12 Tf 72 720 Td (Contratante: Marcos Vinicius Prado, CPF 529.982.247-25.) Tj ET\n' +
      'BT /F1 12 Tf 900 900 Td (Testemunha: Marcos Vinicius Prado) Tj ET\n' +
      '/OC /MC0 BDC BT /F1 30 Tf 100 300 Td (CONFIDENCIAL LAYERMARK) Tj ET EMC';
    const objs = [
      '<< /Type /Catalog /Pages 2 0 R /Outlines 7 0 R /OCProperties << /OCGs [8 0 R] /D << /Order [8 0 R] >> >> >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Annots [6 0 R] /Resources << /Font << /F1 5 0 R >> /Properties << /MC0 8 0 R >> >> >>',
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      '<< /Type /Annot /Subtype /Text /Rect [10 10 30 30] /Contents (ANNOTNOTE Marcos Vinicius Prado ligou) /T (Revisor Marcos) >>',
      '<< /Type /Outlines /First 9 0 R /Last 9 0 R /Count 1 >>',
      '<< /Type /OCG /Name (Marca d\'agua) >>',
      '<< /Title (Contrato Marcos Vinicius Prado) /Parent 7 0 R /Dest [3 0 R /Fit] >>',
    ];
    let s = '%PDF-1.7\n';
    const offs: number[] = [];
    objs.forEach((o, i) => { offs.push(s.length); s += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const x = s.length;
    s += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
    s += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
    const doc = await parsePdf('c.pdf', enc(s));
    expect(doc.segments.join(' ')).toContain('Testemunha: Marcos'); // texto fora da página foi extraído
    const res = await clean(doc);
    const mupdf = await import('mupdf');
    const back = mupdf.Document.openDocument(new Uint8Array(await res.blob.arrayBuffer()), 'application/pdf').asPDF()!;
    const raw = new TextDecoder('latin1').decode(back.saveToBuffer('decompress=yes').asUint8Array());
    for (const leak of ['Marcos', 'ANNOTNOTE', 'LAYERMARK', '529.982']) expect(raw, leak).not.toContain(leak);
    expect(res.report.warnings.join(' ')).not.toContain('Autoverificação');
  });
});
