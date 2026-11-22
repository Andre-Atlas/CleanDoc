import JSZip from 'jszip';
import { MAX_ENTRIES, MAX_UNCOMPRESSED } from './package';
import { MAX_FILE_BYTES, UnsupportedFileError } from './types';

export const SUPPORTED_INNER_EXT = /\.(pdf|docx|xlsx|csv|png|jpe?g|webp)$/i;
const MAX_COMPRESSION_RATIO = 120;
const RATIO_MIN_UNCOMPRESSED = 10 * 1024 * 1024;

export interface ExtractedZipEntry {
  file: File;
  relativePath: string;
}

export interface ZipExtractResult {
  files: ExtractedZipEntry[];
  skipped: string[];
}

interface InternalZipEntry extends JSZip.JSZipObject {
  unsafeOriginalName?: string;
  _data?: { uncompressedSize?: number; compressedSize?: number };
  internalStream(type: 'uint8array'): {
    on(event: 'data', cb: (chunk: Uint8Array) => void): unknown;
    on(event: 'end', cb: () => void): unknown;
    on(event: 'error', cb: (err: unknown) => void): unknown;
    resume(): unknown;
    pause(): unknown;
  };
}

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** Valida e normaliza o caminho interno de uma entrada ZIP contra path traversal e caracteres de controle. */
export function sanitizeZipPath(rawPath: string): string | null {
  if (!rawPath || hasControlChar(rawPath)) return null;
  const normalized = rawPath.replaceAll('\\', '/').replace(/^\/+/, '');
  if (/^[a-zA-Z]:/.test(normalized)) return null;
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length) return null;
  for (const part of parts) {
    if (part === '.' || part === '..') return null;
  }
  if (parts[0] === '__MACOSX' || parts[parts.length - 1]!.startsWith('._')) return null;
  return parts.join('/');
}

/** Verifica se a entrada Unix é symlink ou arquivo especial (não regular). */
function isNonRegularUnixEntry(entry: JSZip.JSZipObject): boolean {
  const mode = typeof entry.unixPermissions === 'number' ? entry.unixPermissions : null;
  if (mode === null) return false;
  const fileType = mode & 0o170000;
  return fileType !== 0 && fileType !== 0o100000;
}

/** Lê a entrada ZIP em streaming abortando imediatamente se exceder limites de tamanho ou razão. */
function readEntryBounded(
  entry: InternalZipEntry,
  maxBytesForEntry: number,
  compressedSize: number,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let received = 0;
    let settled = false;
    const stream = entry.internalStream('uint8array');

    const abort = (err: Error) => {
      if (settled) return;
      settled = true;
      try { stream.pause(); } catch { /* noop */ }
      reject(err);
    };

    stream.on('data', (chunk) => {
      if (settled) return;
      received += chunk.byteLength;
      if (received > maxBytesForEntry) {
        abort(new UnsupportedFileError('ZIP grande demais depois de descompactado (limite de 1 GB / 500 MB por arquivo).', 'corrompido'));
        return;
      }
      if (received >= RATIO_MIN_UNCOMPRESSED && compressedSize > 0 && received / compressedSize > MAX_COMPRESSION_RATIO) {
        abort(new UnsupportedFileError('ZIP suspeito (taxa de compressão excessiva).', 'corrompido'));
        return;
      }
      chunks.push(chunk);
    });

    stream.on('error', (err) => abort(err instanceof Error ? err : new Error(String(err))));
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      if (chunks.length === 1) {
        resolve(chunks[0]!);
        return;
      }
      const out = new Uint8Array(received);
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.byteLength;
      }
      resolve(out);
    });

    stream.resume();
  });
}

/**
 * Descompacta um arquivo .zip no navegador com proteção contra zip bomb (streaming limitado),
 * symlinks Unix e path traversal (`unsafeOriginalName`), retornando apenas arquivos suportados.
 */
export async function extractZipFiles(zipBuffer: ArrayBuffer, zipName: string): Promise<ZipExtractResult> {
  if (zipBuffer.byteLength > MAX_FILE_BYTES) {
    throw new UnsupportedFileError('Arquivo ZIP grande demais (limite de 500 MB).', 'formato');
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipBuffer);
  } catch {
    throw new UnsupportedFileError(`Não foi possível abrir o ZIP "${zipName}". Ele pode estar corrompido ou protegido por senha.`, 'corrompido');
  }

  const allEntries = Object.values(zip.files) as InternalZipEntry[];
  if (allEntries.length > MAX_ENTRIES) {
    throw new UnsupportedFileError(`ZIP com muitas entradas (limite de ${MAX_ENTRIES} arquivos).`, 'corrompido');
  }

  const files: ExtractedZipEntry[] = [];
  const skipped: string[] = [];
  let totalUncompressed = 0;

  for (const entry of allEntries) {
    if (entry.dir) continue;
    const rawName = entry.unsafeOriginalName ?? entry.name;
    const safePath = sanitizeZipPath(rawName);
    if (!safePath || isNonRegularUnixEntry(entry)) {
      skipped.push(rawName);
      continue;
    }
    if (!SUPPORTED_INNER_EXT.test(safePath)) {
      skipped.push(safePath);
      continue;
    }

    const declaredUncompressed = entry._data?.uncompressedSize ?? 0;
    const compressedSize = entry._data?.compressedSize ?? 0;
    if (declaredUncompressed >= RATIO_MIN_UNCOMPRESSED && compressedSize > 0 && declaredUncompressed / compressedSize > MAX_COMPRESSION_RATIO) {
      throw new UnsupportedFileError('ZIP suspeito (taxa de compressão excessiva).', 'corrompido');
    }
    if (declaredUncompressed > MAX_FILE_BYTES) {
      skipped.push(safePath);
      continue;
    }
    if (totalUncompressed + declaredUncompressed > MAX_UNCOMPRESSED) {
      throw new UnsupportedFileError('ZIP grande demais depois de descompactado (limite de 1 GB).', 'corrompido');
    }

    const remainingTotal = MAX_UNCOMPRESSED - totalUncompressed;
    const maxForEntry = Math.min(MAX_FILE_BYTES, remainingTotal);
    const bytes = await readEntryBounded(entry, maxForEntry, compressedSize);
    totalUncompressed += bytes.byteLength;

    const baseName = safePath.split('/').pop() ?? safePath;
    const file = new File([bytes as BlobPart], baseName);
    files.push({ file, relativePath: safePath });
  }

  return { files, skipped };
}
