// Prepara dist-cf/ para Cloudflare Workers Static Assets:
// 1. Copia dist/ excluindo os 2 binários > 25 MiB (servidos via R2) e a cópia duplicada ort-wasm do Vite.
// 2. Gera dist-cf/_headers a partir de vercel.json (fonte única da verdade).
// 3. Garante que nenhum arquivo restante ultrapassa 25 MiB.
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLOUDFLARE_MAX_ASSET_BYTES = 25 * 1024 * 1024;

const EXACT_EXCLUDES = new Set([
  'models/ner/onnx/model_quantized.onnx',
  'ort/ort-wasm-simd-threaded.asyncify.wasm',
]);

const DUPLICATE_ORT_WASM = /^assets\/ort-wasm-simd-threaded\.asyncify-[^/]+\.wasm$/;

function shouldExclude(relPath) {
  return EXACT_EXCLUDES.has(relPath) || DUPLICATE_ORT_WASM.test(relPath);
}

function toCloudflareRoute(vercelSource) {
  return vercelSource.replace(/\/\(\.\*\)$/, '/*');
}

export function buildCloudflareHeaders(vercelConfig) {
  const blocks = [];
  let hasAssetsCache = false;
  let hasOrtCache = false;
  let hasOcrCache = false;

  for (const rule of vercelConfig.headers ?? []) {
    const route = toCloudflareRoute(rule.source);
    if (route === '/assets/*') hasAssetsCache = true;
    if (route === '/ort/*') hasOrtCache = true;
    if (route === '/ocr/*') hasOcrCache = true;
    const lines = [route, ...rule.headers.map((h) => `  ${h.key}: ${h.value}`)];
    blocks.push(lines.join('\n'));
  }

  if (!hasAssetsCache) {
    blocks.push('/assets/*\n  Cache-Control: public, max-age=31536000, immutable');
  }

  if (!hasOrtCache) {
    blocks.push('/ort/*\n  Cache-Control: public, max-age=31536000, immutable');
  }

  if (!hasOcrCache) {
    blocks.push('/ocr/*\n  Cache-Control: public, max-age=31536000, immutable');
  }

  return `${blocks.join('\n\n')}\n`;
}

async function walkFiles(rootDir, currentDir = rootDir) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(rootDir, full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

export async function prepareCloudflareDist({
  srcDir,
  outDir,
  vercelConfig,
  maxAssetBytes = CLOUDFLARE_MAX_ASSET_BYTES,
}) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const files = await walkFiles(srcDir);
  const excluded = [];
  let copied = 0;

  for (const fullPath of files) {
    const relPath = relative(srcDir, fullPath).replaceAll('\\', '/');
    if (shouldExclude(relPath)) {
      excluded.push(relPath);
      continue;
    }

    const info = await stat(fullPath);
    if (info.size > maxAssetBytes) {
      throw new Error(
        `Arquivo ${relPath} (${(info.size / (1024 * 1024)).toFixed(2)} MiB) excede o limite de ${(maxAssetBytes / (1024 * 1024)).toFixed(0)} MiB do Cloudflare Static Assets.`,
      );
    }

    const dest = join(outDir, relPath);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(fullPath, dest);
    copied += 1;
  }

  await writeFile(join(outDir, '_headers'), buildCloudflareHeaders(vercelConfig), 'utf-8');
  excluded.sort();
  return { copied, excluded };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(import.meta.dirname, '..');
  const vercelConfig = JSON.parse(await readFile(resolve(root, 'vercel.json'), 'utf-8'));
  const result = await prepareCloudflareDist({
    srcDir: resolve(root, 'dist'),
    outDir: resolve(root, 'dist-cf'),
    vercelConfig,
  });
  console.log(`dist-cf pronto: ${result.copied} arquivos copiados, ${result.excluded.length} excluídos (${result.excluded.join(', ')}).`);
}
