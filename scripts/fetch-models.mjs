// Baixa o modelo NER PT-BR (BERTimbau / LeNER-Br, ONNX int8) para public/models/ner/.
// Roda UMA vez no build/dev; em produção o modelo é servido pelo próprio site (CSP connect-src 'self').
// Modelo: augustaklug/legal-bert-ner-base-cased-ptbr-onnx (CC-BY-4.0), base dominguesm/legal-bert-ner-base-cased-ptbr.
import { copyFile, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';

const REPO = 'augustaklug/legal-bert-ner-base-cased-ptbr-onnx';
// Revisão fixada + SHA-256 de cada arquivo: o modelo servido não muda sem uma revisão consciente.
const REV = 'fd285c1ce6ebac8280fc4a3dc99aa8889b053538';
const SHA256 = {
  'config.json': 'b7094cb43ee118e520c5029195a15a8db04f3b835018b5ee7ef8f21a4d59e86a',
  'tokenizer.json': '45ccb3e514665f3b11b5e2a8e1a3e29765d94330bc7232aa46c4cdc485bc8881',
  'tokenizer_config.json': '4c4cbad3a414472ebbe2ed543df468d4cbf5cfd87005bf215c7d9cd7c369ccaf',
  'special_tokens_map.json': '5aa43c2f985a25296d5a5ce621c2f77376ca8091a47993c492fd5460b895b140',
  'vocab.txt': '69c28584c67a0e5018f85ca734aa272cc38e26b5dd0d33fffa28059299f21707',
  'onnx/model_quantized.onnx': '40dea08515b0f3f577662a11b3597a56f7c7cee859aea7465488c511ce362acf',
};
const FILES = Object.keys(SHA256);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const OUT = resolve(import.meta.dirname, '../public/models/ner');

for (const f of FILES) {
  const dest = resolve(OUT, f);
  try { if ((await stat(dest)).size > 0 && sha(await readFile(dest)) === SHA256[f]) { console.log('ok (cache)', f); continue; } } catch {}
  const url = `https://huggingface.co/${REPO}/resolve/${REV}/${f}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
  await mkdir(dirname(dest), { recursive: true });
  const buf = Buffer.from(await r.arrayBuffer());
  if (sha(buf) !== SHA256[f]) throw new Error(`${f}: SHA-256 não confere — arquivo do modelo alterado ou corrompido`);
  await writeFile(dest, buf);
  console.log('baixado', f);
}

// Runtime do ONNX (WASM) copiado de node_modules para public/ort/: sem CDN em produção.
const ORT = resolve(import.meta.dirname, '../public/ort');
await mkdir(ORT, { recursive: true });
for (const f of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  await copyFile(resolve(import.meta.dirname, '../node_modules/onnxruntime-web/dist', f), resolve(ORT, f));
  console.log('copiado', f);
}

// Modelo OCR PT-BR (Tesseract 4.0.0_fast, ~1 MB) + runtime WASM self-hosted: sem CDN em produção.
const OCR_MODEL_URL = 'https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0_fast/por.traineddata.gz';
const OCR_MODEL_SHA256 = '7b0f1749aa255a593b14160c75f74690be740edcae94c5a45efc24ab50235f4d';
const OCR_MODEL_DEST = resolve(import.meta.dirname, '../public/models/ocr/por.traineddata.gz');
let ocrCached = false;
try {
  if ((await stat(OCR_MODEL_DEST)).size > 0 && sha(await readFile(OCR_MODEL_DEST)) === OCR_MODEL_SHA256) {
    console.log('ok (cache) ocr/por.traineddata.gz');
    ocrCached = true;
  }
} catch {}
if (!ocrCached) {
  const r = await fetch(OCR_MODEL_URL);
  if (!r.ok) throw new Error(`por.traineddata.gz: HTTP ${r.status}`);
  await mkdir(dirname(OCR_MODEL_DEST), { recursive: true });
  const buf = Buffer.from(await r.arrayBuffer());
  if (sha(buf) !== OCR_MODEL_SHA256) throw new Error('por.traineddata.gz: SHA-256 não confere');
  await writeFile(OCR_MODEL_DEST, buf);
  console.log('baixado ocr/por.traineddata.gz');
}

const OCR_DIR = resolve(import.meta.dirname, '../public/ocr');
await mkdir(OCR_DIR, { recursive: true });
await copyFile(resolve(import.meta.dirname, '../node_modules/tesseract.js/dist/worker.min.js'), resolve(OCR_DIR, 'worker.min.js'));
for (const f of [
  'tesseract-core-relaxedsimd-lstm.wasm.js',
  'tesseract-core-relaxedsimd-lstm.wasm',
  'tesseract-core-relaxedsimd.wasm.js',
  'tesseract-core-relaxedsimd.wasm',
  'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm',
  'tesseract-core-lstm.wasm.js',
  'tesseract-core-lstm.wasm',
  'tesseract-core-simd.wasm.js',
  'tesseract-core-simd.wasm',
  'tesseract-core.wasm.js',
  'tesseract-core.wasm',
]) {
  await copyFile(resolve(import.meta.dirname, '../node_modules/tesseract.js-core', f), resolve(OCR_DIR, f));
}
console.log('copiado runtime OCR (tesseract.js)');
