/**
 * OCR 100% local (Tesseract.js WASM) servido pela própria origem (/ocr/ e /models/ocr/).
 * Sem CDN externa (CSP connect-src 'self') e sem persistência em IndexedDB (cacheMethod: 'none').
 */
export interface OcrBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrWord {
  text: string;
  bbox: OcrBox;
  confidence: number;
}

export interface OcrLine {
  text: string;
  words: OcrWord[];
}

export interface OcrResult {
  lines: OcrLine[];
}

/** Abstração injetável para testar PDF/imagem sem carregar Tesseract WASM em unit tests. */
export interface OcrEngine {
  recognize(image: Blob | Uint8Array | HTMLCanvasElement | OffscreenCanvas): Promise<OcrResult>;
  terminate(): Promise<void>;
}

const OCR_INIT_TIMEOUT_MS = 60_000;

/**
 * Converte a lista de palavras de uma linha do OCR em texto plano + array de caixas
 * por code-unit UTF-16 (compatível com offsets de Entity).
 */
export function lineToCharBoxes(words: OcrWord[]): { text: string; boxes: OcrBox[] } {
  let text = '';
  const boxes: OcrBox[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (i > 0) {
      text += ' ';
      const prev = words[i - 1]!.bbox;
      boxes.push({ x0: prev.x1, y0: Math.min(prev.y0, w.bbox.y0), x1: w.bbox.x0, y1: Math.max(prev.y1, w.bbox.y1) });
    }
    text += w.text;
    for (let k = 0; k < w.text.length; k++) boxes.push(w.bbox);
  }
  return { text, boxes };
}

interface TesseractWordLike {
  text?: string;
  confidence?: number;
  bbox?: OcrBox;
}
interface TesseractLineLike {
  words?: TesseractWordLike[];
}
interface TesseractBlockLike {
  paragraphs?: { lines?: TesseractLineLike[] }[];
}

export function extractLinesFromTesseract(data: { blocks?: TesseractBlockLike[] | null }): OcrLine[] {
  const lines: OcrLine[] = [];
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        const words: OcrWord[] = [];
        for (const w of line.words ?? []) {
          const t = (w.text ?? '').trim();
          if (!t || !w.bbox) continue;
          words.push({ text: t, bbox: w.bbox, confidence: w.confidence ?? 0 });
        }
        if (words.length) lines.push({ text: words.map((w) => w.text).join(' '), words });
      }
    }
  }
  return lines;
}

/** Cria uma instância lazy do Tesseract.js 100% self-hosted com proteção contra erros do sub-worker. */
export function createTesseractOcr(origin: string): OcrEngine {
  type WorkerLike = {
    recognize: (img: unknown, opts?: unknown, output?: unknown) => Promise<{ data: { blocks?: TesseractBlockLike[] | null } }>;
    terminate: () => Promise<unknown>;
  };
  let workerPromise: Promise<WorkerLike> | null = null;
  let lastWorkerError: Error | null = null;

  const getWorker = async (): Promise<WorkerLike> => {
    if (!workerPromise) {
      lastWorkerError = null;
      workerPromise = (async () => {
        const { createWorker } = await import('tesseract.js');
        const base = origin.endsWith('/') ? origin.slice(0, -1) : origin;
        let rejectOnError: ((err: Error) => void) | null = null;
        const errorRace = new Promise<never>((_, rej) => {
          rejectOnError = rej;
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutRace = new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error('Tempo esgotado ao inicializar OCR local.')), OCR_INIT_TIMEOUT_MS);
        });

        const initPromise = createWorker('por', 1, {
          workerPath: `${base}/ocr/worker.min.js`,
          corePath: `${base}/ocr/`,
          langPath: `${base}/models/ocr/`,
          workerBlobURL: false,
          cacheMethod: 'none',
          errorHandler: (err: unknown) => {
            const e = err instanceof Error ? err : new Error(String(err));
            lastWorkerError = e;
            rejectOnError?.(e);
          },
        });

        try {
          const worker = await Promise.race([initPromise, errorRace, timeoutRace]);
          return worker as unknown as WorkerLike;
        } catch (err) {
          // Encerra o worker se vier a resolver depois do timeout/erro para evitar leak.
          void initPromise.then((w) => w.terminate()).catch(() => {});
          workerPromise = null;
          throw err;
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      })();
    }
    return workerPromise;
  };

  return {
    async recognize(image) {
      const worker = await getWorker();
      lastWorkerError = null;
      const { data } = await worker.recognize(image, {}, { blocks: true, text: true });
      if (lastWorkerError) throw lastWorkerError;
      return { lines: extractLinesFromTesseract(data) };
    },
    async terminate() {
      if (!workerPromise) return;
      const p = workerPromise;
      workerPromise = null;
      try {
        const w = await p;
        await w.terminate();
      } catch {
        // ignora erro de inicialização ao encerrar
      }
    },
  };
}
