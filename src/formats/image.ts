import type { Entity } from '../core/types';
import { lineToCharBoxes, type OcrBox, type OcrEngine } from './ocr';
import { countByLabel } from './report';
import { cleanName, UnsupportedFileError, type ParsedFile } from './types';
import { stripLightWatermark } from './watermark';

export const MAX_IMAGE_PIXELS = 40_000_000;

export interface ImageParseOptions {
  ocr?: OcrEngine;
  stripRasterWatermark?: boolean;
}

interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

async function decodeImageBuffer(buf: ArrayBuffer, mime: string): Promise<DecodedImage> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
    throw new UnsupportedFileError('O navegador não suporta decodificação de imagens neste ambiente.', 'formato');
  }
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(new Blob([buf], { type: mime }));
  } catch {
    throw new UnsupportedFileError('Imagem corrompida ou inválida.', 'corrompido');
  }
  try {
    if (bmp.width * bmp.height > MAX_IMAGE_PIXELS) {
      throw new UnsupportedFileError('Imagem com resolução excessiva (limite de 40 megapixels). Reduza a resolução e tente de novo.', 'corrompido');
    }
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new UnsupportedFileError('Não foi possível inicializar o canvas para a imagem.', 'corrompido');
    ctx.drawImage(bmp, 0, 0);
    const imgData = ctx.getImageData(0, 0, bmp.width, bmp.height);
    return { width: bmp.width, height: bmp.height, rgba: imgData.data };
  } finally {
    bmp.close();
  }
}

function mimeForImageName(name: string): string {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return 'image/png';
}

function mergeBoxes(boxes: OcrBox[]): OcrBox {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x0);
    y0 = Math.min(y0, b.y0);
    x1 = Math.max(x1, b.x1);
    y1 = Math.max(y1, b.y1);
  }
  return { x0, y0, x1, y1 };
}

/**
 * Parser de imagens (PNG, JPEG, WEBP):
 * - Remove opcionalmente marcas d'água claras/pastéis sobre fundo branco.
 * - Roda OCR local PT-BR (Tesseract WASM) para extrair texto e caixas de cada palavra.
 * - Na aplicação, apaga os pixels das áreas detectadas, escreve os rótulos e re-codifica
 *   como PNG limpo (eliminando 100% de EXIF/IPTC/XMP).
 */
export async function parseImage(
  name: string,
  buf: ArrayBuffer,
  opts: ImageParseOptions = {},
  decode: (buf: ArrayBuffer, mime: string) => Promise<DecodedImage> = decodeImageBuffer,
): Promise<ParsedFile> {
  const mime = mimeForImageName(name);
  const { width, height, rgba } = await decode(buf, mime);
  let wmRemoved = 0;
  if (opts.stripRasterWatermark !== false) {
    const wm = stripLightWatermark(rgba, width, height, 4);
    if (wm.modified) wmRemoved = 1;
  }

  const warnings: string[] = [];
  const lineData: { text: string; boxes: OcrBox[] }[] = [];

  if (opts.ocr) {
    let ocrInput: Blob | OffscreenCanvas;
    if (typeof OffscreenCanvas !== 'undefined') {
      const c = new OffscreenCanvas(width, height);
      const ctx = c.getContext('2d')!;
      ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
      ocrInput = await c.convertToBlob({ type: 'image/png' });
    } else {
      ocrInput = new Blob([buf], { type: mime });
    }
    const res = await opts.ocr.recognize(ocrInput);
    for (const line of res.lines) {
      const mapped = lineToCharBoxes(line.words);
      if (mapped.text.trim()) lineData.push(mapped);
    }
    if (!lineData.length) {
      warnings.push('OCR local não encontrou texto legível nesta imagem. Apenas metadados (EXIF) serão removidos.');
    }
  } else {
    warnings.push('OCR local indisponível: o texto da imagem não foi analisado. Apenas metadados (EXIF) serão removidos.');
  }

  const segments = lineData.map((l) => l.text);

  return {
    kind: 'image',
    name,
    segments,
    warnings,
    async apply(masks) {
      const all: Entity[] = masks.flat();
      let blob: Blob;

      if (typeof OffscreenCanvas !== 'undefined') {
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d')!;
        ctx.putImageData(new ImageData(rgba, width, height), 0, 0);

        for (let i = 0; i < lineData.length; i++) {
          const line = lineData[i]!;
          const ents = masks[i] ?? [];
          for (const e of ents) {
            const slice = line.boxes.slice(e.start, e.end);
            if (!slice.length) continue;
            const box = mergeBoxes(slice);
            const pad = 2;
            const x = Math.max(0, box.x0 - pad);
            const y = Math.max(0, box.y0 - pad);
            const w = Math.max(8, box.x1 - box.x0 + pad * 2);
            const h = Math.max(10, box.y1 - box.y0 + pad * 2);
            ctx.fillStyle = '#f0f0f0';
            ctx.fillRect(x, y, w, h);
            const fontSize = Math.max(8, Math.min(h * 0.72, (w / Math.max(1, e.label.length)) * 1.65, 22));
            ctx.fillStyle = '#222222';
            ctx.font = `${Math.round(fontSize)}px monospace`;
            ctx.textBaseline = 'middle';
            ctx.fillText(e.label, x + 2, y + h / 2, Math.max(4, w - 4));
          }
        }
        blob = await canvas.convertToBlob({ type: 'image/png' });
      } else {
        // Fallback para ambiente de teste jsdom/Node sem OffscreenCanvas
        blob = new Blob([rgba as BlobPart], { type: 'image/png' });
      }

      const outName = cleanName(name.replace(/\.(jpe?g|webp)$/i, '.png'), all);
      const metadata = [{ description: 'Metadados de imagem (EXIF/XMP/IPTC) removidos por recodificação', count: 1 }];
      if (wmRemoved) metadata.push({ description: "Marca d'água clara rasterizada removida", count: wmRemoved });

      return {
        blob,
        fileName: outName,
        report: {
          fileName: outName,
          kind: 'image',
          entities: countByLabel(all),
          maskedCount: all.length,
          metadata,
          watermarksRemoved: wmRemoved,
          warnings,
        },
      };
    },
  };
}
