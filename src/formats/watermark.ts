/**
 * Filtro determinístico de remoção de marcas d'água claras/translúcidas em páginas rasterizadas
 * (ex.: texto diagonal em cinza claro, lavanda ou azul pastel sobre fundo branco).
 *
 * - Suporta buffers RGB (3 canais, ex.: MuPDF com alpha=false) e RGBA (4 canais, compondo
 *   pixels semitransparentes sobre fundo branco antes da avaliação).
 * - Só atua em páginas de fundo predominantemente claro (≥ 60% dos pixels amostrados com
 *   luminância ≥ 205) para não degradar fotografias ou páginas com fundo escuro.
 * - Só modifica o buffer se a quantidade de pixels de marca d'água ultrapassar o limiar mínimo.
 */
export interface WatermarkCleanResult {
  modified: boolean;
  pixelsCleared: number;
}

function compositeRgb(pixels: Uint8ClampedArray, idx: number, channels: 3 | 4): [number, number, number] {
  const r = pixels[idx]!;
  const g = pixels[idx + 1]!;
  const b = pixels[idx + 2]!;
  if (channels === 3) return [r, g, b];
  const a = pixels[idx + 3]!;
  if (a >= 255) return [r, g, b];
  if (a === 0) return [255, 255, 255];
  const f = a / 255;
  const inv = 1 - f;
  return [Math.round(r * f + 255 * inv), Math.round(g * f + 255 * inv), Math.round(b * f + 255 * inv)];
}

function isWatermarkPixel(r: number, g: number, b: number): boolean {
  if (r >= 252 && g >= 252 && b >= 252) return false;
  const minC = Math.min(r, g, b);
  const maxC = Math.max(r, g, b);
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  const isLightTint = minC >= 185 && lum >= 200;
  const isPastelWatermark = minC >= 175 && maxC - minC >= 12 && lum >= 198;
  return isLightTint || isPastelWatermark;
}

export function stripLightWatermark(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  channels: 3 | 4 = 4,
): WatermarkCleanResult {
  const totalPixels = width * height;
  if (totalPixels <= 0 || pixels.length < totalPixels * channels) return { modified: false, pixelsCleared: 0 };

  // Verifica se o fundo da página é predominantemente branco/claro (amostragem uniforme).
  const step = Math.max(1, Math.floor(totalPixels / 4096));
  let sampled = 0;
  let brightBg = 0;
  for (let p = 0; p < totalPixels; p += step) {
    const [r, g, b] = compositeRgb(pixels, p * channels, channels);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum >= 205) brightBg++;
    sampled++;
  }
  if (sampled === 0 || brightBg / sampled < 0.6) {
    return { modified: false, pixelsCleared: 0 };
  }

  // Passada 1: conta pixels candidatos antes de mutar o buffer in-place.
  const threshold = Math.max(20, totalPixels * 0.0005);
  let cleared = 0;
  for (let p = 0; p < totalPixels; p++) {
    const [r, g, b] = compositeRgb(pixels, p * channels, channels);
    if (isWatermarkPixel(r, g, b)) cleared++;
  }
  if (cleared <= threshold) {
    return { modified: false, pixelsCleared: 0 };
  }

  // Passada 2: limpa apenas quando ultrapassa o limiar relevante.
  for (let p = 0; p < totalPixels; p++) {
    const idx = p * channels;
    const [r, g, b] = compositeRgb(pixels, idx, channels);
    if (isWatermarkPixel(r, g, b)) {
      pixels[idx] = 255;
      pixels[idx + 1] = 255;
      pixels[idx + 2] = 255;
      if (channels === 4) pixels[idx + 3] = 255;
    }
  }

  return { modified: true, pixelsCleared: cleared };
}
