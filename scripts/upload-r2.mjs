// Envia os 2 binários > 25 MiB para o bucket Cloudflare R2 (cleandoc-models).
// Executa fetch-models.mjs antes para garantir integridade SHA-256 e sincronismo com node_modules.
// Requer autenticação prévia com `npx wrangler login` e bucket criado (`npx wrangler r2 bucket create cleandoc-models`).
import { spawnSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const BUCKET = process.env.CF_R2_BUCKET || 'cleandoc-models';
const BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
if (!BUCKET_RE.test(BUCKET)) {
  console.error(`Nome de bucket R2 inválido: "${BUCKET}". Use apenas [a-z0-9-], 3–63 caracteres.`);
  process.exit(1);
}

const ROOT = resolve(import.meta.dirname, '..');

function runOrFail(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  if (res.error) {
    console.error(`Falha ao executar ${cmd}: ${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

// Garante integridade SHA-256 do modelo NER e copia o runtime ONNX atualizado de node_modules.
runOrFail(process.execPath, [resolve(ROOT, 'scripts/fetch-models.mjs')]);

const OBJECTS = [
  {
    key: 'models/ner/onnx/model_quantized.onnx',
    file: resolve(ROOT, 'public/models/ner/onnx/model_quantized.onnx'),
    contentType: 'application/octet-stream',
  },
  {
    key: 'ort/ort-wasm-simd-threaded.asyncify.wasm',
    file: resolve(ROOT, 'public/ort/ort-wasm-simd-threaded.asyncify.wasm'),
    contentType: 'application/wasm',
  },
];

for (const obj of OBJECTS) {
  const info = await stat(obj.file);
  if (info.size === 0) {
    console.error(`Arquivo vazio: ${obj.file}`);
    process.exit(1);
  }

  console.log(`Enviando ${obj.key} (${(info.size / (1024 * 1024)).toFixed(1)} MiB) para R2 (${BUCKET})...`);
  runOrFail('npx', [
    'wrangler',
    'r2',
    'object',
    'put',
    `${BUCKET}/${obj.key}`,
    '--file',
    obj.file,
    '--content-type',
    obj.contentType,
    '--cache-control',
    'public, max-age=31536000, immutable',
    '--remote',
  ]);
}

console.log('Upload para R2 concluído.');
