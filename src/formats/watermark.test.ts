import { describe, expect, it } from 'vitest';
import { stripLightWatermark } from './watermark';

function fillRgba(w: number, h: number, r: number, g: number, b: number): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h * 4; i += 4) {
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = 255;
  }
  return buf;
}

describe('stripLightWatermark', () => {
  it('remove marca d\'água lavanda/cinza clara preservando texto escuro e azul escuro', () => {
    const w = 40, h = 40;
    const rgba = fillRgba(w, h, 255, 255, 255);
    // 50 pixels de marca d'água lavanda clara (semelhante ao PDF de exemplo)
    for (let p = 0; p < 50; p++) {
      rgba[p * 4] = 222;
      rgba[p * 4 + 1] = 216;
      rgba[p * 4 + 2] = 248;
    }
    // pixel 100: texto preto
    rgba[100 * 4] = 35; rgba[100 * 4 + 1] = 35; rgba[100 * 4 + 2] = 35;
    // pixel 101: cabeçalho azul escuro (#003366)
    rgba[101 * 4] = 0; rgba[101 * 4 + 1] = 51; rgba[101 * 4 + 2] = 102;

    const res = stripLightWatermark(rgba, w, h);

    expect(res.modified).toBe(true);
    expect(res.pixelsCleared).toBe(50);
    // marca d'água virou branco
    expect([rgba[0], rgba[1], rgba[2]]).toEqual([255, 255, 255]);
    // texto preto preservado
    expect([rgba[100 * 4], rgba[100 * 4 + 1], rgba[100 * 4 + 2]]).toEqual([35, 35, 35]);
    // cabeçalho azul escuro preservado
    expect([rgba[101 * 4], rgba[101 * 4 + 1], rgba[101 * 4 + 2]]).toEqual([0, 51, 102]);
  });

  it('não altera imagem com fundo escuro (ex.: fotografia)', () => {
    const w = 20, h = 20;
    const rgba = fillRgba(w, h, 40, 45, 55);
    rgba[0] = 220; rgba[1] = 220; rgba[2] = 245;

    const res = stripLightWatermark(rgba, w, h);

    expect(res.modified).toBe(false);
    expect(res.pixelsCleared).toBe(0);
    expect([rgba[0], rgba[1], rgba[2]]).toEqual([220, 220, 245]);
  });
});
