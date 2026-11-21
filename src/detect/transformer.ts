import { tokenize, type Token } from '../core/text';
import type { Candidate, Category } from '../core/types';

/**
 * Camada 3: self-attention. BERTimbau (BERT base PT-BR) ajustado para NER jurídico (LeNER-Br),
 * em ONNX int8, rodando localmente via transformers.js. Classificamos por PALAVRA do nosso
 * tokenizador (primeira sub-palavra), o que dá offsets exatos de caractere.
 */

export interface WordLabel {
  label: string; // ex.: B-PESSOA
  score: number;
  /** palavra não coube no limite de 512 sub-palavras desta janela */
  skipped?: boolean;
}

/** Abstração para testar o pipeline sem baixar o modelo. */
export interface WordClassifier {
  classifyWords(words: string[]): Promise<WordLabel[]>;
}

const CAT: Record<string, Category> = { PESSOA: 'pessoa', ORGANIZACAO: 'empresa', LOCAL: 'local' };

export async function detectTransformer(text: string, model: WordClassifier): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const toks = tokenize(text);
  // janelas de até 180 palavras com sobreposição de 30 (cabe em 512 sub-palavras)
  const WIN = 180, OVER = 30;
  const seen = new Set<string>();
  let s = 0;
  while (s < toks.length) {
    const win = toks.slice(s, s + WIN);
    let labels: WordLabel[];
    try {
      labels = await model.classifyWords(win.map((t) => t.text));
    } catch {
      return out; // falha de inferência: segue sem o transformer (as outras camadas cobrem)
    }
    const used = labels.findIndex((l) => l.skipped);
    const covered = used === -1 ? win.length : used;
    for (const c of bioToSpans(win.slice(0, covered), labels.slice(0, covered))) {
      const key = `${c.start}:${c.end}:${c.category}`;
      if (!seen.has(key)) { seen.add(key); out.push(c); }
    }
    if (s + covered >= toks.length) break;
    // próxima janela começa antes do corte (sobreposição), sem pular palavras não classificadas
    s += Math.max(1, covered - OVER);
  }
  return out;
}

export function bioToSpans(toks: Token[], labels: WordLabel[]): Candidate[] {
  const out: Candidate[] = [];
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]!.label;
    if (l === 'O') continue;
    const tag = l.slice(2);
    const cat = CAT[tag];
    let j = i + 1;
    while (j < labels.length && labels[j]!.label === `I-${tag}`) j++;
    if (cat) {
      const score = Math.min(...labels.slice(i, j).map((x) => x.score));
      out.push({ start: toks[i]!.start, end: toks[j - 1]!.end, category: cat, source: 'transformer', confidence: score });
    }
    i = j - 1;
  }
  return out;
}

/** Implementação real com transformers.js. Carregada só dentro do Web Worker. */
export async function loadBertNer(opts: { modelPath: string; wasmBase?: string; onProgress?: (p: number) => void }): Promise<WordClassifier> {
  const { AutoTokenizer, AutoModelForTokenClassification, AutoConfig, Tensor, env } = await import('@huggingface/transformers');
  // Runtime ONNX servido pelo próprio site: o padrão da biblioteca é uma CDN externa (proibido aqui).
  const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number } };
  if (opts.wasmBase && !onnx.wasm) throw new Error('runtime ONNX sem configuração wasm: recusando o padrão (CDN externa)');
  if (opts.wasmBase && onnx.wasm) {
    onnx.wasm.wasmPaths = { mjs: `${opts.wasmBase}ort-wasm-simd-threaded.asyncify.mjs`, wasm: `${opts.wasmBase}ort-wasm-simd-threaded.asyncify.wasm` };
    // threads só com isolamento de origem (COOP/COEP); senão, 1 thread
    if (typeof crossOriginIsolated === 'undefined' || !crossOriginIsolated) onnx.wasm.numThreads = 1;
  }
  // sem blob: (bloqueado pela CSP script-src 'self'): importa o runtime direto de /ort/
  env.useWasmCache = false;
  // sem Cache Storage: o modelo volta do cache HTTP (Cache-Control immutable), nada é gravado pela aplicação
  env.useBrowserCache = false;
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = opts.modelPath;
  const progress = (e: { status?: string; progress?: number; file?: string }) => {
    if (e.status === 'progress' && typeof e.progress === 'number' && e.file?.endsWith('.onnx')) opts.onProgress?.(e.progress / 100);
  };
  const id = 'ner';
  const [tokenizer, model, config] = await Promise.all([
    AutoTokenizer.from_pretrained(id),
    AutoModelForTokenClassification.from_pretrained(id, { dtype: 'q8', progress_callback: progress }),
    AutoConfig.from_pretrained(id),
  ]);
  const id2label = (config as unknown as { id2label: Record<string, string> }).id2label;
  const special = tokenizer.encode('') as number[];
  const cls = special[0] ?? 101;
  const sep = special[special.length - 1] ?? 102;
  const cache = new Map<string, number[]>();
  const pieces = (w: string) => {
    let p = cache.get(w);
    if (!p) {
      p = tokenizer.encode(w, { add_special_tokens: false }) as number[];
      if (cache.size > 50_000) cache.clear();
      cache.set(w, p);
    }
    return p;
  };
  return {
    async classifyWords(words) {
      const ids: number[] = [cls];
      const first: number[] = [];
      for (const w of words) {
        const p = pieces(w).slice(0, 8);
        if (ids.length + p.length >= 511) { first.push(-2); continue; }
        first.push(p.length ? ids.length : -1);
        ids.push(...(p.length ? p : []));
      }
      ids.push(sep);
      const n = ids.length;
      const big = (xs: number[]) => BigInt64Array.from(xs.map((x) => BigInt(x)));
      const { logits } = await model({
        input_ids: new Tensor('int64', big(ids), [1, n]),
        attention_mask: new Tensor('int64', big(ids.map(() => 1)), [1, n]),
        token_type_ids: new Tensor('int64', big(ids.map(() => 0)), [1, n]),
      });
      const data = logits.data as Float32Array;
      const C = logits.dims[2] as number;
      return first.map((pos) => {
        if (pos === -2) return { label: 'O', score: 0, skipped: true };
        if (pos < 0) return { label: 'O', score: 0 };
        const row = data.subarray(pos * C, pos * C + C);
        let k = 0;
        for (let c = 1; c < C; c++) if (row[c]! > row[k]!) k = c;
        const mx = row[k]!;
        let s = 0;
        for (let c = 0; c < C; c++) s += Math.exp(row[c]! - mx);
        return { label: id2label[String(k)] ?? 'O', score: 1 / s };
      });
    },
  };
}
