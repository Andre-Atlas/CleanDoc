import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCloudflareHeaders, prepareCloudflareDist } from './prepare-cf.mjs';

const tempDirs = [];

async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'cleandoc-cf-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('prepare-cf', () => {
  it('converte headers do vercel.json para o formato _headers da Cloudflare', () => {
    const out = buildCloudflareHeaders({
      headers: [
        {
          source: '/(.*)',
          headers: [
            { key: 'Content-Security-Policy', value: "default-src 'self'" },
            { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          ],
        },
        {
          source: '/models/(.*)',
          headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
        },
      ],
    });

    expect(out).toContain('/*\n  Content-Security-Policy: default-src \'self\'\n  Cross-Origin-Opener-Policy: same-origin');
    expect(out).toContain('/assets/*\n  Cache-Control: public, max-age=31536000, immutable');
    expect(out).toContain('/models/*\n  Cache-Control: public, max-age=31536000, immutable');
    expect(out).toContain('/ort/*\n  Cache-Control: public, max-age=31536000, immutable');
  });

  it('remove arquivos servidos pelo R2 e duplicado ort-wasm, mantendo o restante e gerando _headers', async () => {
    const root = await makeTempDir();
    const src = join(root, 'dist');
    const dst = join(root, 'dist-cf');
    await mkdir(join(src, 'models/ner/onnx'), { recursive: true });
    await mkdir(join(src, 'ort'), { recursive: true });
    await mkdir(join(src, 'assets'), { recursive: true });

    await writeFile(join(src, 'index.html'), '<!doctype html>');
    await writeFile(join(src, 'models/crf.json'), '{}');
    await writeFile(join(src, 'models/ner/onnx/model_quantized.onnx'), 'big-model');
    await writeFile(join(src, 'ort/ort-wasm-simd-threaded.asyncify.mjs'), 'export {}');
    await writeFile(join(src, 'ort/ort-wasm-simd-threaded.asyncify.wasm'), 'big-wasm');
    await writeFile(join(src, 'assets/ort-wasm-simd-threaded.asyncify-ABC123.wasm'), 'dup-wasm');
    await writeFile(join(src, 'assets/app-123.js'), 'console.log(1)');

    const result = await prepareCloudflareDist({
      srcDir: src,
      outDir: dst,
      vercelConfig: {
        headers: [{ source: '/(.*)', headers: [{ key: 'X-Content-Type-Options', value: 'nosniff' }] }],
      },
      maxAssetBytes: 1024,
    });

    expect(result.excluded).toEqual([
      'assets/ort-wasm-simd-threaded.asyncify-ABC123.wasm',
      'models/ner/onnx/model_quantized.onnx',
      'ort/ort-wasm-simd-threaded.asyncify.wasm',
    ]);
    expect(await readFile(join(dst, 'index.html'), 'utf-8')).toBe('<!doctype html>');
    expect(await readFile(join(dst, 'models/crf.json'), 'utf-8')).toBe('{}');
    expect(await readFile(join(dst, 'ort/ort-wasm-simd-threaded.asyncify.mjs'), 'utf-8')).toBe('export {}');
    expect(await readFile(join(dst, '_headers'), 'utf-8')).toContain('X-Content-Type-Options: nosniff');
  });

  it('falha quando algum arquivo restante excede o limite de 25 MiB', async () => {
    const root = await makeTempDir();
    const src = join(root, 'dist');
    const dst = join(root, 'dist-cf');
    await mkdir(join(src, 'assets'), { recursive: true });
    await writeFile(join(src, 'assets/huge.wasm'), Buffer.alloc(2048));

    await expect(
      prepareCloudflareDist({
        srcDir: src,
        outDir: dst,
        vercelConfig: { headers: [] },
        maxAssetBytes: 1024,
      }),
    ).rejects.toThrow(/excede o limite/i);
  });
});
