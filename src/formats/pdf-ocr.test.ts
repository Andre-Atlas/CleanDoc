import * as mupdf from 'mupdf';
import { describe, expect, it, vi } from 'vitest';
import type { OcrEngine } from './ocr';
import { parsePdf } from './pdf';

describe('parsePdf com página rasterizada (OCR local + limpeza de marca d\'água clara)', () => {
  it('roda OCR em página sem texto, remove marca d\'água clara e aplica redação real', async () => {
    const pdf = new mupdf.PDFDocument();
    // Página com fundo branco + faixa lavanda clara (sem texto nativo)
    const page = pdf.addPage(
      [0, 0, 200, 100],
      0,
      pdf.newDictionary(),
      'q 1 1 1 rg 0 0 200 100 re f 0.87 0.85 0.97 rg 10 20 180 60 re f Q',
    );
    pdf.insertPage(-1, page);
    const bytes = pdf.saveToBuffer('compress=yes').asUint8Array();

    const ocr: OcrEngine = {
      recognize: vi.fn(async () => ({
        lines: [
          {
            text: 'Ronald Acioli',
            words: [
              { text: 'Ronald', bbox: { x0: 20, y0: 20, x1: 100, y1: 50 }, confidence: 92 },
              { text: 'Acioli', bbox: { x0: 110, y0: 20, x1: 180, y1: 50 }, confidence: 91 },
            ],
          },
        ],
      })),
      terminate: vi.fn(async () => {}),
    };

    const parsed = await parsePdf('escaneado.pdf', bytes.slice().buffer, { ocr, stripRasterWatermark: true });

    expect(ocr.recognize).toHaveBeenCalledOnce();
    expect(parsed.segments).toEqual(['Ronald Acioli']);
    expect(parsed.warnings.some((w) => /OCR local aplicado/i.test(w))).toBe(true);

    const res = await parsed.apply([
      [
        {
          start: 0,
          end: 13,
          text: 'Ronald Acioli',
          category: 'pessoa',
          label: '[nome pessoal]',
          detections: [{ source: 'termo', confidence: 1 }],
          confidence: 1,
        },
      ],
    ]);

    expect(res.report.maskedCount).toBe(1);
    expect(res.report.watermarksRemoved).toBeGreaterThanOrEqual(1);
    expect(res.blob.size).toBeGreaterThan(0);
  });

  it('lida com página sem fundo branco pintado e /Rotate 90 sem corromper dimensões', async () => {
    const pdf = new mupdf.PDFDocument();
    const page = pdf.addPage(
      [0, 0, 200, 300],
      90,
      pdf.newDictionary(),
      'q 0.87 0.85 0.97 rg 10 20 180 60 re f Q',
    );
    pdf.insertPage(-1, page);
    const bytes = pdf.saveToBuffer('compress=yes').asUint8Array();

    const ocr: OcrEngine = {
      recognize: vi.fn(async () => ({ lines: [] })),
      terminate: vi.fn(async () => {}),
    };

    const parsed = await parsePdf('rotacionado.pdf', bytes.slice().buffer, { ocr, stripRasterWatermark: true });
    const res = await parsed.apply([]);

    expect(res.report.watermarksRemoved).toBeGreaterThanOrEqual(1);
    const outDoc = mupdf.Document.openDocument(new Uint8Array(await res.blob.arrayBuffer()), 'application/pdf');
    const outBounds = outDoc.loadPage(0).getBounds();
    outDoc.destroy();
    // Após normalizar /Rotate 90, a página fica 300x200 (paisagem), sem dupla rotação
    expect(Math.round(outBounds[2] - outBounds[0])).toBe(300);
    expect(Math.round(outBounds[3] - outBounds[1])).toBe(200);
  });
});
