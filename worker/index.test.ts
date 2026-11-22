import { describe, expect, it, vi } from 'vitest';
import worker, { type Env, type R2Object, type R2ObjectBody } from './index';

function makeStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function makeEnv(overrides: Partial<Env> = {}) {
  const get = vi.fn();
  const head = vi.fn();
  const assetsFetch = vi.fn(async () => new Response('asset-ok', { status: 200 }));
  const env: Env = {
    MODELS_BUCKET: { get, head },
    ASSETS: { fetch: assetsFetch },
    ...overrides,
  };
  return { env, get, head, assetsFetch };
}

function expectSecurityHeaders(res: Response) {
  expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'; frame-ancestors 'none'");
  expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
  expect(res.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
  expect(res.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
  expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=63072000');
}

describe('Cloudflare Worker R2 asset proxy', () => {
  it('serve model_quantized.onnx via R2 em 1 chamada com headers de segurança e cache imutável', async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const { env, get, head, assetsFetch } = makeEnv();
    get.mockResolvedValue({
      key: 'models/ner/onnx/model_quantized.onnx',
      size: payload.byteLength,
      httpEtag: '"abc123"',
      body: makeStream(payload),
    } satisfies R2ObjectBody);

    const res = await worker.fetch(new Request('https://cleandoc.workers.dev/models/ner/onnx/model_quantized.onnx'), env);

    expect(res.status).toBe(200);
    expect(head).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledWith('models/ner/onnx/model_quantized.onnx');
    expect(assetsFetch).not.toHaveBeenCalled();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(payload);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('ETag')).toBe('"abc123"');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('Content-Length')).toBe('4');
    expectSecurityHeaders(res);
  });

  it('serve ort-wasm-simd-threaded.asyncify.wasm via R2 com Content-Type application/wasm', async () => {
    const payload = new Uint8Array([0x00, 0x61, 0x73, 0x6d]);
    const { env, get } = makeEnv();
    get.mockResolvedValue({
      key: 'ort/ort-wasm-simd-threaded.asyncify.wasm',
      size: payload.byteLength,
      httpEtag: '"wasm-etag"',
      body: makeStream(payload),
    } satisfies R2ObjectBody);

    const res = await worker.fetch(new Request('https://cleandoc.workers.dev/ort/ort-wasm-simd-threaded.asyncify.wasm'), env);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/wasm');
    expectSecurityHeaders(res);
  });

  it('responde HEAD sem corpo usando MODELS_BUCKET.head e suporta If-None-Match (304)', async () => {
    const { env, head, get } = makeEnv();
    head.mockResolvedValue({
      key: 'models/ner/onnx/model_quantized.onnx',
      size: 179_000_000,
      httpEtag: '"head-etag"',
    } satisfies R2Object);

    const okRes = await worker.fetch(
      new Request('https://cleandoc.workers.dev/models/ner/onnx/model_quantized.onnx', { method: 'HEAD' }),
      env,
    );
    expect(okRes.status).toBe(200);
    expect(get).not.toHaveBeenCalled();
    expect(okRes.body).toBeNull();
    expect(okRes.headers.get('Content-Length')).toBe('179000000');

    const notModRes = await worker.fetch(
      new Request('https://cleandoc.workers.dev/models/ner/onnx/model_quantized.onnx', {
        method: 'HEAD',
        headers: { 'If-None-Match': '"head-etag"' },
      }),
      env,
    );
    expect(notModRes.status).toBe(304);
    expect(notModRes.body).toBeNull();
    expectSecurityHeaders(notModRes);
  });

  it('retorna 304 em GET quando If-None-Match casa com ETag', async () => {
    const { env, head, get } = makeEnv();
    head.mockResolvedValue({
      key: 'models/ner/onnx/model_quantized.onnx',
      size: 100,
      httpEtag: '"same-etag"',
    } satisfies R2Object);

    const res = await worker.fetch(
      new Request('https://cleandoc.workers.dev/models/ner/onnx/model_quantized.onnx', {
        headers: { 'If-None-Match': 'W/"same-etag"' },
      }),
      env,
    );

    expect(res.status).toBe(304);
    expect(get).not.toHaveBeenCalled();
    expect(res.body).toBeNull();
    expect(res.headers.get('ETag')).toBe('"same-etag"');
    expectSecurityHeaders(res);
  });

  it('retorna 412 Precondition Failed quando If-Match diverge do ETag', async () => {
    const { env, head, get } = makeEnv();
    head.mockResolvedValue({
      key: 'models/ner/onnx/model_quantized.onnx',
      size: 100,
      httpEtag: '"new-etag"',
    } satisfies R2Object);

    const res = await worker.fetch(
      new Request('https://cleandoc.workers.dev/models/ner/onnx/model_quantized.onnx', {
        headers: { 'If-Match': '"old-etag"' },
      }),
      env,
    );

    expect(res.status).toBe(412);
    expect(get).not.toHaveBeenCalled();
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expectSecurityHeaders(res);
  });

  it('retorna 206 Partial Content para Range fechado e Range aberto (bytes=4-)', async () => {
    const chunk = new Uint8Array([10, 11, 12, 13]);
    const { env, head, get } = makeEnv();
    head.mockResolvedValue({
      key: 'models/ner/onnx/model_quantized.onnx',
      size: 10,
      httpEtag: '"range-etag"',
    } satisfies R2Object);
    get.mockResolvedValue({
      key: 'models/ner/onnx/model_quantized.onnx',
      size: 10,
      httpEtag: '"range-etag"',
      body: makeStream(chunk),
    } satisfies R2ObjectBody);

    const res = await worker.fetch(
      new Request('https://cleandoc.workers.dev/models/ner/onnx/model_quantized.onnx', {
        headers: { Range: 'bytes=0-3' },
      }),
      env,
    );

    expect(res.status).toBe(206);
    expect(get).toHaveBeenCalledWith('models/ner/onnx/model_quantized.onnx', { range: { offset: 0, length: 4 } });
    expect(res.headers.get('Content-Range')).toBe('bytes 0-3/10');
    expect(res.headers.get('Content-Length')).toBe('4');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(chunk);

    const openChunk = new Uint8Array([4, 5, 6, 7, 8, 9]);
    get.mockResolvedValue({
      key: 'models/ner/onnx/model_quantized.onnx',
      size: 10,
      httpEtag: '"range-etag"',
      body: makeStream(openChunk),
    } satisfies R2ObjectBody);
    const openRes = await worker.fetch(
      new Request('https://cleandoc.workers.dev/models/ner/onnx/model_quantized.onnx', {
        headers: { Range: 'bytes=4-' },
      }),
      env,
    );
    expect(openRes.status).toBe(206);
    expect(get).toHaveBeenCalledWith('models/ner/onnx/model_quantized.onnx', { range: { offset: 4, length: 6 } });
    expect(openRes.headers.get('Content-Range')).toBe('bytes 4-9/10');
    expect(openRes.headers.get('Content-Length')).toBe('6');
  });

  it('retorna 416 Range Not Satisfiable para Range fora dos limites ou invertido', async () => {
    const { env, head, get } = makeEnv();
    head.mockResolvedValue({
      key: 'models/ner/onnx/model_quantized.onnx',
      size: 10,
      httpEtag: '"range-etag"',
    } satisfies R2Object);

    for (const bad of ['bytes=999-', 'bytes=8-2', 'bytes=-0']) {
      const res = await worker.fetch(
        new Request('https://cleandoc.workers.dev/models/ner/onnx/model_quantized.onnx', {
          headers: { Range: bad },
        }),
        env,
      );
      expect(res.status).toBe(416);
      expect(res.headers.get('Content-Range')).toBe('bytes */10');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expectSecurityHeaders(res);
    }
    expect(get).not.toHaveBeenCalled();
  });

  it('ignora Range e retorna 200 completo quando If-Range diverge ou multi-range é enviado', async () => {
    const full = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const { env, head, get } = makeEnv();
    head.mockResolvedValue({
      key: 'models/ner/onnx/model_quantized.onnx',
      size: 10,
      httpEtag: '"current-etag"',
    } satisfies R2Object);
    get.mockImplementation(async () => ({
      key: 'models/ner/onnx/model_quantized.onnx',
      size: 10,
      httpEtag: '"current-etag"',
      body: makeStream(full),
    }));

    const ifRangeRes = await worker.fetch(
      new Request('https://cleandoc.workers.dev/models/ner/onnx/model_quantized.onnx', {
        headers: { Range: 'bytes=0-3', 'If-Range': '"old-etag"' },
      }),
      env,
    );
    expect(ifRangeRes.status).toBe(200);
    expect(ifRangeRes.headers.get('Content-Length')).toBe('10');

    const multiRes = await worker.fetch(
      new Request('https://cleandoc.workers.dev/models/ner/onnx/model_quantized.onnx', {
        headers: { Range: 'bytes=0-1, 3-4' },
      }),
      env,
    );
    expect(multiRes.status).toBe(200);
    expect(multiRes.headers.get('Content-Length')).toBe('10');
  });

  it('recusa métodos diferentes de GET e HEAD com 405 e headers de segurança', async () => {
    const { env, get, head } = makeEnv();
    const res = await worker.fetch(
      new Request('https://cleandoc.workers.dev/models/ner/onnx/model_quantized.onnx', { method: 'POST' }),
      env,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, HEAD');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expectSecurityHeaders(res);
    expect(get).not.toHaveBeenCalled();
    expect(head).not.toHaveBeenCalled();
  });

  it('retorna 404 com headers de segurança quando objeto não existe no R2', async () => {
    const { env, get } = makeEnv();
    get.mockResolvedValue(null);

    const res = await worker.fetch(new Request('https://cleandoc.workers.dev/models/ner/onnx/model_quantized.onnx'), env);
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expectSecurityHeaders(res);
  });

  it('captura exceções do R2 e retorna 500 com headers de segurança', async () => {
    const { env, get } = makeEnv();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    get.mockRejectedValue(new Error('R2 transient failure'));

    const res = await worker.fetch(new Request('https://cleandoc.workers.dev/models/ner/onnx/model_quantized.onnx'), env);
    expect(res.status).toBe(500);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expectSecurityHeaders(res);
    expect(errSpy).toHaveBeenCalledOnce();
    errSpy.mockRestore();
  });

  it.each([
    '/',
    '/models/crf.json',
    '/models/../secret',
    '/models/ner/onnx/model_quantized.onnx/extra',
    '/ort/ort-wasm-simd-threaded.asyncify.mjs',
  ])('delega rota fora da whitelist (%s) para env.ASSETS.fetch sem tocar o R2', async (path) => {
    const { env, get, head, assetsFetch } = makeEnv();
    const req = new Request(`https://cleandoc.workers.dev${path}`);

    const res = await worker.fetch(req, env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('asset-ok');
    expect(assetsFetch).toHaveBeenCalledWith(req);
    expect(get).not.toHaveBeenCalled();
    expect(head).not.toHaveBeenCalled();
  });
});
