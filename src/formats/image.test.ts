import { describe, expect, it, vi } from 'vitest';
import { parseImage } from './image';
import type { OcrEngine } from './ocr';

describe('parseImage', () => {
  it('extrai texto via OCR, remove marca d\'água clara e gera PNG limpo', async () => {
    const w = 40, h = 40;
    const rgba = new Uint8ClampedArray(w * h * 4).fill(255);
    for (let p = 0; p < 50; p++) {
      rgba[p * 4] = 225; rgba[p * 4 + 1] = 220; rgba[p * 4 + 2] = 248;
    }
    const ocr: OcrEngine = {
      recognize: vi.fn(async () => ({
        lines: [
          {
            text: 'Ronald Silva',
            words: [
              { text: 'Ronald', bbox: { x0: 2, y0: 2, x1: 18, y1: 12 }, confidence: 95 },
              { text: 'Silva', bbox: { x0: 20, y0: 2, x1: 35, y1: 12 }, confidence: 94 },
            ],
          },
        ],
      })),
      terminate: vi.fn(async () => {}),
    };

    const parsed = await parseImage(
      'scan_Ronald.jpg',
      new ArrayBuffer(16),
      { ocr, stripRasterWatermark: true },
      async () => ({ width: w, height: h, rgba }),
    );

    expect(parsed.kind).toBe('image');
    expect(parsed.segments).toEqual(['Ronald Silva']);
    expect(parsed.warnings).toEqual([]);

    const result = await parsed.apply([
      [
        {
          start: 0,
          end: 12,
          text: 'Ronald Silva',
          category: 'pessoa',
          label: '[nome pessoal]',
          detections: [{ source: 'termo', confidence: 1 }],
          confidence: 1,
        },
      ],
    ]);

    expect(result.fileName).toBe('scan_X_limpo.png');
    expect(result.report.kind).toBe('image');
    expect(result.report.maskedCount).toBe(1);
    expect(result.report.watermarksRemoved).toBe(1);
    expect(result.blob.type).toBe('image/png');
  });

  it('emite aviso quando OCR não está disponível', async () => {
    const rgba = new Uint8ClampedArray(10 * 10 * 4).fill(255);
    const parsed = await parseImage(
      'foto.png',
      new ArrayBuffer(8),
      {},
      async () => ({ width: 10, height: 10, rgba }),
    );
    expect(parsed.segments).toEqual([]);
    expect(parsed.warnings.some((w) => /OCR local indisponível/i.test(w))).toBe(true);
  });
});
