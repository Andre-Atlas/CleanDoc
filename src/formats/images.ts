/** Remove metadados de imagens embutidas (EXIF/XMP/GPS/comentários) sem recodificar pixels. */

export function stripJpeg(buf: Uint8Array): { data: Uint8Array; removed: number } {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return { data: buf, removed: 0 };
  const parts: Uint8Array[] = [buf.subarray(0, 2)];
  let i = 2;
  let removed = 0;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1]!;
    if (marker === 0xda) { parts.push(buf.subarray(i)); i = buf.length; break; } // início dos dados: copia o resto
    const len = (buf[i + 2]! << 8) | buf[i + 3]!;
    const seg = buf.subarray(i, i + 2 + len);
    // APP1 (EXIF/XMP), APP3–APP13, APP15 e COM saem; APP0 (JFIF), APP2 (ICC) e APP14 (Adobe) ficam.
    const drop = marker === 0xe1 || (marker >= 0xe3 && marker <= 0xed) || marker === 0xef || marker === 0xfe;
    if (drop) removed++;
    else parts.push(seg);
    i += 2 + len;
  }
  if (i < buf.length) parts.push(buf.subarray(i));
  return { data: concat(parts), removed };
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

export function stripPng(buf: Uint8Array): { data: Uint8Array; removed: number } {
  if (!PNG_SIG.every((b, k) => buf[k] === b)) return { data: buf, removed: 0 };
  const parts: Uint8Array[] = [buf.subarray(0, 8)];
  let i = 8;
  let removed = 0;
  while (i + 12 <= buf.length) {
    const len = ((buf[i]! << 24) >>> 0) + (buf[i + 1]! << 16) + (buf[i + 2]! << 8) + buf[i + 3]!;
    const type = String.fromCharCode(buf[i + 4]!, buf[i + 5]!, buf[i + 6]!, buf[i + 7]!);
    const chunk = buf.subarray(i, i + 12 + len);
    if (PNG_DROP.has(type)) removed++;
    else parts.push(chunk);
    i += 12 + len;
  }
  return { data: concat(parts), removed };
}

export function stripImage(name: string, buf: Uint8Array) {
  if (/\.jpe?g$/i.test(name)) return stripJpeg(buf);
  if (/\.png$/i.test(name)) return stripPng(buf);
  return { data: buf, removed: 0 };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
