import JSZip from 'jszip';
import { parseDocx } from './docx';
import { joinSegments, splitEntities } from '../core/segments';
import { detectAll } from '../detect/pipeline';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:v="urn:schemas-microsoft-com:vml"';

async function makeDocx(): Promise<ArrayBuffer> {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types><Override PartName="/word/comments.xml" ContentType="x"/><Override PartName="/docProps/custom.xml" ContentType="y"/></Types>');
  z.file('_rels/.rels', '<Relationships><Relationship Id="r9" Target="docProps/custom.xml"/></Relationships>');
  z.file('word/_rels/document.xml.rels', '<Relationships><Relationship Id="r1" Target="comments.xml"/><Relationship Id="r2" Target="header1.xml"/></Relationships>');
  z.file(
    'word/document.xml',
    `<w:document ${W}><w:body>` +
      // nome dividido em dois runs com formatação diferente
      `<w:p w:rsidR="00AB12CD"><w:r><w:t>Contratante: Ana Bea</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>triz Costa, CPF 529.982.247-25.</w:t></w:r></w:p>` +
      `<w:p><w:commentRangeStart w:id="0"/><w:r><w:t xml:space="preserve">Valor: R$ 10.000,00 </w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>` +
      `<w:p><w:del w:author="Carlos Lima"><w:r><w:delText>texto antigo secreto</w:delText></w:r></w:del><w:ins w:author="Carlos Lima"><w:r><w:t>A Sra. Costa assina.</w:t></w:r></w:ins></w:p>` +
      `</w:body></w:document>`,
  );
  z.file('word/header1.xml', `<w:hdr ${W}><w:p><w:r><w:pict><v:shape id="PowerPlusWaterMarkObject1"><v:textpath string="CONFIDENCIAL"/></v:shape></w:pict></w:r></w:p><w:p><w:r><w:t>Construtora Alfa Ltda</w:t></w:r></w:p></w:hdr>`);
  z.file('word/comments.xml', `<w:comments ${W}><w:comment w:author="Carlos Lima"><w:p><w:r><w:t>revisar</w:t></w:r></w:p></w:comment></w:comments>`);
  z.file('word/settings.xml', `<w:settings ${W}><w:attachedTemplate r:id="x"/><w:rsids><w:rsidRoot w:val="00AB12CD"/></w:rsids><w:docVars><w:docVar w:name="cliente" w:val="Ana"/></w:docVars></w:settings>`);
  z.file('docProps/core.xml', '<cp:coreProperties xmlns:cp="c" xmlns:dc="d" xmlns:dcterms="t"><dc:creator>Carlos Lima</dc:creator><cp:lastModifiedBy>Carlos Lima</cp:lastModifiedBy><dc:title>Contrato Ana</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">2025-03-02T10:00:00Z</dcterms:created></cp:coreProperties>');
  z.file('docProps/app.xml', '<Properties><Company>Construtora Alfa</Company><TotalTime>93</TotalTime></Properties>');
  z.file('docProps/custom.xml', '<Properties><property name="cliente"><vt:lpwstr>Ana</vt:lpwstr></property></Properties>');
  return z.generateAsync({ type: 'arraybuffer' });
}

it('limpa DOCX: texto entre runs, revisões, comentários, marca d\'água e metadados', async () => {
  const doc = await parseDocx('contrato.docx', await makeDocx());
  expect(doc.segments.join('|')).not.toContain('texto antigo secreto');
  const { text, starts } = joinSegments(doc.segments);
  const [ents] = await detectAll([text], { terms: [{ text: 'Construtora Alfa Ltda', category: 'empresa' }] });
  const res = await doc.apply(splitEntities(ents!, doc.segments, starts));
  const out = await JSZip.loadAsync(await res.blob.arrayBuffer());
  const all = (await Promise.all(Object.keys(out.files).map((p) => out.file(p)?.async('string') ?? ''))).join('\n');

  for (const secret of ['Ana Bea', 'triz Costa', '529.982.247-25', 'R$ 10.000', 'Costa assina', 'Carlos Lima', 'CONFIDENCIAL', 'Construtora Alfa', 'Contrato Ana', '00AB12CD', 'texto antigo', '2025-03-02'])
    expect(all, secret).not.toContain(secret);
  const body = await out.file('word/document.xml')!.async('string');
  expect(body).toContain('[nome pessoal]');
  expect(body).toContain('[CPF]');
  expect(body).toContain('<w:b/>'); // formatação preservada
  expect(out.file('word/comments.xml')).toBeNull();
  expect(out.file('docProps/custom.xml')).toBeNull();
  expect(res.report.watermarksRemoved).toBe(1);
  expect(res.fileName).toBe('contrato_limpo.docx');
});
