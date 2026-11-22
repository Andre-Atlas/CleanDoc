import type { Entity } from '../core/types';
import { lineToCharBoxes, type OcrEngine } from './ocr';
import { cleanName, MIME, UnsupportedFileError, type ParsedFile } from './types';
import { countByLabel } from './report';
import { stripLightWatermark } from './watermark';

export interface PdfParseOptions {
  ocr?: OcrEngine;
  stripRasterWatermark?: boolean;
  onPageProgress?: (page: number, total: number) => void;
}

/**
 * PDF com mupdf.js (WASM): extrai texto com a posição de cada caractere (ou roda OCR local
 * em páginas escaneadas/rasterizadas), aplica redação REAL (texto e pixels sob a área somem),
 * escreve o rótulo sobre a área, remove Info/XMP, anotações de marca d'água, conteúdo /Watermark,
 * camadas "marca d'água"/"watermark" e marcas d'água claras em páginas rasterizadas.
 */
type Mupdf = typeof import('mupdf');
type Quad = [number, number, number, number, number, number, number, number];

interface PageText {
  /** um segmento por linha */
  lines: { text: string; quads: Quad[] }[];
  /** PNG com marca d'água clara removida, quando a página era rasterizada */
  cleanRasterPng?: Uint8Array;
}

const MAX_PAGES = 2000;
const OCR_DPI = 200;
const MAX_RASTER_PIXELS = 40_000_000;
let mupdfPromise: Promise<Mupdf> | null = null;
const loadMupdf = () => (mupdfPromise ??= import('mupdf'));

export async function parsePdf(name: string, buf: ArrayBuffer, opts: PdfParseOptions = {}): Promise<ParsedFile> {
  const mupdf = await loadMupdf();
  let doc;
  try {
    doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf');
  } catch {
    throw new UnsupportedFileError('PDF corrompido ou inválido.', 'corrompido');
  }
  if (doc.needsPassword()) {
    doc.destroy();
    throw new UnsupportedFileError('PDF protegido por senha. Remova a senha e adicione de novo.', 'senha');
  }
  const pdf = doc.asPDF();
  if (!pdf) {
    doc.destroy();
    throw new UnsupportedFileError('Arquivo não é um PDF.', 'formato');
  }
  const totalPages = pdf.countPages();
  if (totalPages > MAX_PAGES) {
    doc.destroy();
    throw new UnsupportedFileError(`PDF com mais de ${MAX_PAGES} páginas. Divida o arquivo.`, 'corrompido');
  }
  const pages: PageText[] = [];
  let nativeChars = 0;
  let ocrPages = 0;
  let scannedNoOcr = 0;

  for (let p = 0; p < totalPages; p++) {
    const page = pdf.loadPage(p);
    try {
      // mediabox-clip=no: texto posicionado fora da página também é extraído (e depois redigido)
      const st = page.toStructuredText('preserve-whitespace,mediabox-clip=no');
      const lines: PageText['lines'] = [];
      let pageChars = 0;
      let cur: PageText['lines'][number] | null = null;
      try {
        st.walk({
          beginLine() { cur = { text: '', quads: [] }; },
          onChar(c, _o, _f, _s, quad) {
            if (!cur) return;
            cur.text += c;
            // cada code unit recebe o quad (chars fora do BMP ocupam 2)
            for (let k = 0; k < c.length; k++) cur.quads.push(quad as Quad);
          },
          endLine() { if (cur) { lines.push(cur); pageChars += cur.text.trim().length; } cur = null; },
        });
      } finally {
        st.destroy();
      }
      nativeChars += pageChars;

      let cleanRasterPng: Uint8Array | undefined;
      if (pageChars < 20) {
        if (opts.ocr) {
          const bounds = page.getBounds();
          const pageW = Math.max(1, bounds[2] - bounds[0]);
          const pageH = Math.max(1, bounds[3] - bounds[1]);
          // Limita a 40 MP para evitar OOM em páginas com MediaBox extremo.
          const maxScale = Math.sqrt(MAX_RASTER_PIXELS / (pageW * pageH));
          const scale = Math.min(OCR_DPI / 72, maxScale);
          // alpha=false (fundo branco opaco) e showExtras=false (não queima anotações/formulários não analisados).
          const pm = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, false);
          let pngForOcr: Uint8Array;
          try {
            if (opts.stripRasterWatermark !== false) {
              const px = pm.getPixels();
              const wm = stripLightWatermark(px, pm.getWidth(), pm.getHeight(), 3);
              if (wm.modified) cleanRasterPng = pm.asPNG().slice();
            }
            pngForOcr = cleanRasterPng ?? pm.asPNG().slice();
          } finally {
            pm.destroy();
          }
          const ocrRes = await opts.ocr.recognize(new Blob([pngForOcr as BlobPart], { type: 'image/png' }));
          for (const line of ocrRes.lines) {
            const mapped = lineToCharBoxes(line.words);
            if (!mapped.text.trim()) continue;
            const quads: Quad[] = mapped.boxes.map((b) => {
              const x0 = bounds[0] + b.x0 / scale;
              const y0 = bounds[1] + b.y0 / scale;
              const x1 = bounds[0] + b.x1 / scale;
              const y1 = bounds[1] + b.y1 / scale;
              return [x0, y0, x1, y0, x0, y1, x1, y1];
            });
            lines.push({ text: mapped.text, quads });
          }
          ocrPages++;
          opts.onPageProgress?.(p + 1, totalPages);
        } else {
          scannedNoOcr++;
        }
      }

      pages.push({ lines, cleanRasterPng });
    } finally {
      page.destroy();
    }
  }
  const warnings: string[] = [];
  if (scannedNoOcr > 0 && nativeChars < 20 * Math.max(1, pages.length)) {
    warnings.push('PDF escaneado ou sem texto: o conteúdo das imagens não foi analisado. Só os metadados foram limpos.');
  } else if (ocrPages > 0) {
    warnings.push(`OCR local aplicado em ${ocrPages} ${ocrPages === 1 ? 'página rasterizada' : 'páginas rasterizadas'}. Revise os itens detectados antes de compartilhar.`);
  }
  const segments = pages.flatMap((pg) => pg.lines.map((l) => l.text));

  return {
    kind: 'pdf',
    name,
    segments,
    warnings,
    async apply(masks) {
      let k = 0;
      let watermarks = 0;
      let annots = 0;
      const metadata: { description: string; count: number }[] = [];
      // camadas opcionais com nome de marca d'água: o CONTEÚDO marcado com elas sai de cada página
      const wmLayers = watermarkLayers(pdf.getTrailer().get('Root'));
      let pageExtras = 0;
      for (let p = 0; p < pages.length; p++) {
        const page = pdf.loadPage(p) as import('mupdf').PDFPage;
        const pageObj = page.getObject();
        // miniatura (pré-redação), dados de aplicativo, XMP e anexos da página
        for (const key of ['Thumb', 'PieceInfo', 'Metadata', 'AF', 'B']) if (!pageObj.get(key).isNull()) { pageObj.delete(key); pageExtras++; }
        if (wmLayers.size) watermarks += stripLayerContent(pageObj, wmLayers);
        // anotações (comentários, links com URL, campos de formulário, marcas d'água) não são analisadas: saem todas (antes de criar as redações)
        for (const a of page.getAnnotations()) {
          if (a.getType() === 'Watermark') watermarks++;
          else annots++;
          page.deleteAnnotation(a);
        }
        const labels: { rect: [number, number, number, number]; label: string }[] = [];
        let redactions = 0;
        for (const line of pages[p]!.lines) {
          const ents: Entity[] = masks[k++] ?? [];
          for (const e of ents) {
            const qs = line.quads.slice(e.start, e.end);
            if (!qs.length) continue;
            const rect = bbox(qs);
            const annot = page.createAnnotation('Redact');
            annot.setRect(rect);
            annot.setQuadPoints(qs.map(expand));
            labels.push({ rect, label: e.label });
            redactions++;
          }
        }
        // Se a página rasterizada teve marca d'água clara removida, substitui o conteúdo pela imagem limpa antes das redações.
        const cleanPng = pages[p]!.cleanRasterPng;
        if (cleanPng) {
          replacePageWithImage(mupdf, pdf, page, cleanPng);
          watermarks++;
        }
        watermarks += stripWatermarkContent(pageObj);
        if (redactions) {
          // black_boxes=false; imagens sob a área: pixels apagados (2); texto: remove (0)
          page.applyRedactions(false, 2, 2, 0);
          for (const { rect, label } of labels) drawLabel(mupdf, pdf, page, rect, label);
        }
      }
      // metadados (trailer/raiz relidos: a redação pode reparar o documento e trocar os objetos)
      const trailer = pdf.getTrailer();
      const root = trailer.get('Root');
      const info = trailer.get('Info');
      if (!info.isNull()) {
        trailer.delete('Info');
        metadata.push({ description: 'Autor, título, software e datas do PDF', count: 1 });
      }
      if (!root.get('Metadata').isNull()) {
        root.delete('Metadata');
        metadata.push({ description: 'Metadados XMP', count: 1 });
      }
      for (const key of ['PieceInfo', 'Perms', 'Threads', 'SpiderInfo', 'Lang']) if (!root.get(key).isNull()) root.delete(key);
      // marcadores (títulos podem ter nomes), formulários, ações e JavaScript
      let structural = 0;
      for (const key of ['Outlines', 'AcroForm', 'OpenAction', 'AA', 'StructTreeRoot', 'MarkInfo', 'AF', 'Dests', 'Collection', 'URI', 'SpiderInfo']) if (!root.get(key).isNull()) { root.delete(key); structural++; }
      if (pageExtras) metadata.push({ description: 'Miniaturas, anexos e dados de aplicativo das páginas', count: pageExtras });
      if (annots) metadata.push({ description: 'Comentários, links e campos de formulário', count: annots });
      if (structural) metadata.push({ description: 'Marcadores, formulários e ações do PDF', count: structural });
      if (annots && warnings.every((w) => !/formulário/.test(w))) warnings.push('Comentários, links e campos de formulário do PDF foram removidos (não são analisados).');
      if (wmLayers.size) { root.delete('OCProperties'); watermarks += wmLayers.size; }
      if (!trailer.get('ID').isNull()) trailer.delete('ID');
      // Names guarda anexos, JavaScript e destinos nomeados (nomes podem conter dados)
      const names = root.get('Names');
      if (!names.isNull()) {
        if (!names.get('EmbeddedFiles').isNull()) {
          metadata.push({ description: 'Arquivos anexados ao PDF', count: 1 });
          warnings.push('Arquivos anexados ao PDF foram removidos.');
        }
        root.delete('Names');
      }
      if (watermarks) metadata.push({ description: 'Marca d\'água', count: watermarks });
      const outBuf = pdf.saveToBuffer('garbage=4,compress=yes,clean=yes,sanitize=yes');
      const out = outBuf.asUint8Array().slice();
      outBuf.destroy();
      const all = masks.flat();
      const leftover = verifyPdf(mupdf, out, all);
      if (leftover) warnings.push(`Autoverificação: "${leftover}" ainda aparece no PDF limpo. Revise antes de compartilhar.`);
      return {
        blob: new Blob([out as BlobPart], { type: MIME.pdf }),
        fileName: cleanName(name, all),
        report: { fileName: cleanName(name, all), kind: 'pdf', entities: countByLabel(all), maskedCount: all.length, metadata, watermarksRemoved: watermarks, warnings },
      };
    },
  };
}

function bbox(qs: Quad[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of qs) for (let i = 0; i < 8; i += 2) { x0 = Math.min(x0, q[i]!); x1 = Math.max(x1, q[i]!); y0 = Math.min(y0, q[i + 1]!); y1 = Math.max(y1, q[i + 1]!); }
  return [x0, y0, x1, y1];
}

/** Aumenta 0,3pt para não sobrar pixel de glifo na borda. */
function expand(q: Quad): Quad {
  const [x0, y0, x1, , , y2] = q;
  return [x0 - 0.3, y0 - 0.3, x1 + 0.3, q[3] - 0.3, q[4] - 0.3, y2 + 0.3, q[6] + 0.3, q[7] + 0.3];
}

/** Substitui o conteúdo de uma página rasterizada pela imagem já sem marca d'água clara, normalizando MediaBox/Rotate. */
function replacePageWithImage(mupdf: Mupdf, pdf: import('mupdf').PDFDocument, page: import('mupdf').PDFPage, png: Uint8Array) {
  const [x0, y0, x1, y1] = page.getBounds();
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const img = new mupdf.Image(png);
  let imgRef;
  try {
    imgRef = pdf.addImage(img);
  } finally {
    img.destroy();
  }
  const pageObj = page.getObject();
  const box = pdf.newArray();
  box.push(0); box.push(0); box.push(w); box.push(h);
  pageObj.put('MediaBox', box);
  pageObj.delete('CropBox');
  pageObj.put('Rotate', 0);
  const res = pdf.newDictionary();
  const xobj = pdf.newDictionary();
  xobj.put('DCRaster', imgRef);
  res.put('XObject', xobj);
  pageObj.put('Resources', res);
  const ops = `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} 0 0 cm /DCRaster Do Q\n`;
  const stream = pdf.addStream(ops, pdf.newDictionary());
  pageObj.put('Contents', stream);
}

/** Escreve o rótulo como conteúdo de página (não como anotação, para não sumir em visualizadores). */
function drawLabel(mupdf: Mupdf, pdf: import('mupdf').PDFDocument, page: import('mupdf').PDFPage, rect: [number, number, number, number], label: string) {
  const [x0, y0, x1, y1] = rect;
  const h = Math.max(4, y1 - y0);
  const size = Math.min(h * 0.8, ((x1 - x0) / Math.max(1, label.length)) * 1.9, 11);
  const pageObj = page.getObject();
  let res = pageObj.get('Resources');
  if (res.isNull()) { res = pdf.newDictionary(); pageObj.put('Resources', res); }
  let fonts = res.get('Font');
  if (fonts.isNull()) { fonts = pdf.newDictionary(); res.put('Font', fonts); }
  if (fonts.get('DCMono').isNull()) fonts.put('DCMono', pdf.addSimpleFont(new mupdf.Font('Courier'), 'Latin'));
  const pageH = page.getBounds()[3];
  // coordenadas do structured text têm origem no topo; PDF tem origem embaixo
  const by = pageH - y1 + (h - size) / 2 + size * 0.2;
  const esc = latin1(label).replace(/[\\()]/g, (c) => '\\' + c);
  const ops = `q 0.94 0.94 0.94 rg ${x0.toFixed(2)} ${(pageH - y1).toFixed(2)} ${(x1 - x0).toFixed(2)} ${h.toFixed(2)} re f 0.2 0.2 0.2 rg BT /DCMono ${size.toFixed(2)} Tf ${x0.toFixed(2)} ${by.toFixed(2)} Td (${esc}) Tj ET Q\n`;
  const stream = pdf.addStream(ops, pdf.newDictionary());
  const contents = pageObj.get('Contents');
  if (contents.isArray()) contents.push(stream);
  else { const arr = pdf.newArray(); if (!contents.isNull()) arr.push(contents); arr.push(stream); pageObj.put('Contents', arr); }
}

function latin1(s: string) {
  return [...s].map((c) => (c.charCodeAt(0) < 256 ? c : '?')).join('');
}

const latin1Decode = (b: Uint8Array) => { let out = ''; for (let i = 0; i < b.length; i += 8192) out += String.fromCharCode(...b.subarray(i, i + 8192)); return out; };
const latin1Encode = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

function contentStreams(pageObj: import('mupdf').PDFObject): import('mupdf').PDFObject[] {
  const contents = pageObj.get('Contents');
  const list = contents.isArray() ? Array.from({ length: contents.length }, (_, i) => contents.get(i)) : [contents];
  return list.filter((s) => !s.isNull() && s.isStream());
}

/** Edita streams de conteúdo byte a byte (latin1), sem corromper dados binários de imagens inline. */
function editStreams(pageObj: import('mupdf').PDFObject, fn: (raw: string) => string): void {
  for (const s of contentStreams(pageObj)) {
    const raw = latin1Decode(s.readStream().asUint8Array());
    const out = fn(raw);
    if (out !== raw) s.writeStream(latin1Encode(out));
  }
}

/** Remove conteúdo marcado como marca d'água (/Artifact <</Subtype /Watermark>> BDC … EMC). */
function stripWatermarkContent(pageObj: import('mupdf').PDFObject): number {
  let n = 0;
  editStreams(pageObj, (raw) => raw.replace(/\/Artifact\s*<<[^>]*\/(?:Subtype|Type)\s*\/Watermark[^>]*>>\s*BDC[\s\S]*?EMC/g, () => (n++, '')));
  return n;
}

/** Números de objeto das camadas opcionais (OCG) com nome de marca d'água. */
function watermarkLayers(root: import('mupdf').PDFObject): Set<number> {
  const out = new Set<number>();
  const oc = root.get('OCProperties');
  if (oc.isNull()) return out;
  const ocgs = oc.get('OCGs');
  if (ocgs.isNull() || !ocgs.isArray()) return out;
  for (let i = 0; i < ocgs.length; i++) {
    const g = ocgs.get(i);
    const nm = g.get('Name');
    if (!nm.isNull() && /water\s*mark|marca\s*d.?[aá]gua/i.test(nm.asString()) && g.isIndirect()) out.add(g.asIndirect());
  }
  return out;
}

/** Remove da página o conteúdo /OC /Nome BDC … EMC das camadas de marca d'água. */
function stripLayerContent(pageObj: import('mupdf').PDFObject, layers: Set<number>): number {
  const res = pageObj.getInheritable('Resources');
  if (res.isNull()) return 0;
  const props = res.get('Properties');
  if (props.isNull()) return 0;
  const keys: string[] = [];
  props.forEach((v, k) => { if (v.isIndirect() && layers.has(v.asIndirect())) keys.push(String(k)); });
  if (!keys.length) return 0;
  let n = 0;
  const re = new RegExp(`/OC\\s*/(?:${keys.map((k) => k.replace(/[^\w.-]/g, '')).join('|')})\\s*BDC[\\s\\S]*?EMC`, 'g');
  editStreams(pageObj, (raw) => raw.replace(re, () => (n++, '')));
  return n;
}

/**
 * Autoverificação: reabre o PDF limpo, extrai todo o texto (inclusive fora da página) e os metadados,
 * e procura cada termo mascarado (≥ 4 caracteres). Devolve o primeiro encontrado.
 */
function verifyPdf(mupdf: Mupdf, data: Uint8Array, entities: Entity[]): string | null {
  const needles = [...new Set(entities.map((e) => e.text.trim()).filter((t) => t.replace(/\W/g, '').length >= 4))];
  if (!needles.length) return null;
  const doc = mupdf.Document.openDocument(data, 'application/pdf');
  try {
    let text = '';
    for (let i = 0; i < doc.countPages(); i++) {
      const p = doc.loadPage(i);
      try {
        const st = p.toStructuredText('preserve-whitespace,mediabox-clip=no');
        try {
          text += st.asText() + '\n';
        } finally {
          st.destroy();
        }
      } finally {
        p.destroy();
      }
    }
    text += ['info:Title', 'info:Author', 'info:Subject', 'info:Keywords', 'info:Creator', 'info:Producer'].map((k) => doc.getMetaData(k) ?? '').join('\n');
    const flat = text.replace(/\s+/g, ' ');
    return needles.find((n) => flat.includes(n.replace(/\s+/g, ' '))) ?? null;
  } finally {
    doc.destroy();
  }
}
