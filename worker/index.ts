export interface R2Range {
  offset?: number;
  length?: number;
  suffix?: number;
}

export interface R2Object {
  key: string;
  size: number;
  httpEtag: string;
}

export interface R2ObjectBody extends R2Object {
  body: ReadableStream<Uint8Array>;
}

export interface R2GetOptions {
  range?: R2Range;
}

export interface R2Bucket {
  get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null>;
  head(key: string): Promise<R2Object | null>;
}

export interface Fetcher {
  fetch(input: Request | string): Promise<Response>;
}

export interface Env {
  ASSETS: Fetcher;
  MODELS_BUCKET: R2Bucket;
}

interface R2AssetEntry {
  key: string;
  contentType: string;
}

const R2_ASSETS = new Map<string, R2AssetEntry>([
  [
    '/models/ner/onnx/model_quantized.onnx',
    { key: 'models/ner/onnx/model_quantized.onnx', contentType: 'application/octet-stream' },
  ],
  [
    '/ort/ort-wasm-simd-threaded.asyncify.wasm',
    { key: 'ort/ort-wasm-simd-threaded.asyncify.wasm', contentType: 'application/wasm' },
  ],
]);

const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'"],
  ['Cross-Origin-Opener-Policy', 'same-origin'],
  ['Cross-Origin-Embedder-Policy', 'require-corp'],
  ['Cross-Origin-Resource-Policy', 'same-origin'],
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'no-referrer'],
  ['Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload'],
];

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

function buildAssetHeaders(contentType: string, etag: string): Headers {
  const headers = new Headers();
  for (const [k, v] of SECURITY_HEADERS) headers.set(k, v);
  headers.set('Cache-Control', IMMUTABLE_CACHE);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Type', contentType);
  headers.set('ETag', etag);
  return headers;
}

function errorResponse(status: number, body: string, extra: Record<string, string> = {}): Response {
  const headers = new Headers();
  for (const [k, v] of SECURITY_HEADERS) headers.set(k, v);
  headers.set('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(body, { status, headers });
}

function stripWeak(tag: string): string {
  return tag.trim().replace(/^W\//i, '');
}

function matchesEtagList(headerValue: string, etag: string): boolean {
  const target = stripWeak(etag);
  return headerValue
    .split(',')
    .map((part) => part.trim())
    .some((part) => part === '*' || stripWeak(part) === target);
}

function matchesIfRange(ifRange: string, etag: string): boolean {
  const trimmed = ifRange.trim();
  // Strong comparison required for ETag in If-Range (RFC 9110 §13.1.5)
  if (trimmed.startsWith('W/') || trimmed.startsWith('w/')) return false;
  return trimmed === etag;
}

type ParsedRange =
  | { kind: 'ignore' }
  | { kind: 'unsatisfiable' }
  | { kind: 'valid'; start: number; end: number; length: number };

function parseByteRange(rangeHeader: string, totalSize: number): ParsedRange {
  const trimmed = rangeHeader.trim();
  if (!trimmed.startsWith('bytes=')) return { kind: 'ignore' };
  const spec = trimmed.slice('bytes='.length).trim();
  // Multi-range ou vazio: ignora Range e devolve 200 completo (RFC 9110 §14.2)
  if (!spec || spec.includes(',')) return { kind: 'ignore' };

  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match) return { kind: 'ignore' };
  const [, startStr, endStr] = match;
  if (!startStr && !endStr) return { kind: 'ignore' };
  if (totalSize <= 0) return { kind: 'unsatisfiable' };

  if (!startStr && endStr) {
    const suffix = Number(endStr);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { kind: 'unsatisfiable' };
    const length = Math.min(suffix, totalSize);
    return { kind: 'valid', start: totalSize - length, end: totalSize - 1, length };
  }

  const start = Number(startStr);
  if (!Number.isSafeInteger(start) || start >= totalSize) return { kind: 'unsatisfiable' };

  if (!endStr) {
    return { kind: 'valid', start, end: totalSize - 1, length: totalSize - start };
  }

  const rawEnd = Number(endStr);
  if (!Number.isSafeInteger(rawEnd) || rawEnd < start) return { kind: 'unsatisfiable' };
  const end = Math.min(rawEnd, totalSize - 1);
  return { kind: 'valid', start, end, length: end - start + 1 };
}

function evaluatePreconditions(request: Request, etag: string): 304 | 412 | null {
  const ifMatch = request.headers.get('If-Match');
  if (ifMatch && !matchesEtagList(ifMatch, etag)) return 412;

  const ifNoneMatch = request.headers.get('If-None-Match');
  if (ifNoneMatch && matchesEtagList(ifNoneMatch, etag)) return 304;

  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const entry = R2_ASSETS.get(pathname);
    if (!entry) return env.ASSETS.fetch(request);

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return errorResponse(405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    }

    try {
      const hasConditionOrRange =
        request.method === 'HEAD' ||
        request.headers.has('If-Match') ||
        request.headers.has('If-None-Match') ||
        request.headers.has('Range');

      if (!hasConditionOrRange) {
        const obj = await env.MODELS_BUCKET.get(entry.key);
        if (!obj) return errorResponse(404, 'Not Found');
        const headers = buildAssetHeaders(entry.contentType, obj.httpEtag);
        headers.set('Content-Length', String(obj.size));
        return new Response(obj.body, { status: 200, headers });
      }

      const meta = await env.MODELS_BUCKET.head(entry.key);
      if (!meta) return errorResponse(404, 'Not Found');

      const preStatus = evaluatePreconditions(request, meta.httpEtag);
      if (preStatus === 412) {
        return errorResponse(412, 'Precondition Failed', { ETag: meta.httpEtag });
      }
      if (preStatus === 304) {
        return new Response(null, { status: 304, headers: buildAssetHeaders(entry.contentType, meta.httpEtag) });
      }

      if (request.method === 'HEAD') {
        const headers = buildAssetHeaders(entry.contentType, meta.httpEtag);
        headers.set('Content-Length', String(meta.size));
        return new Response(null, { status: 200, headers });
      }

      const rangeHeader = request.headers.get('Range');
      const ifRange = request.headers.get('If-Range');
      const rangeAllowed = !ifRange || matchesIfRange(ifRange, meta.httpEtag);

      if (rangeHeader && rangeAllowed) {
        const parsed = parseByteRange(rangeHeader, meta.size);
        if (parsed.kind === 'unsatisfiable') {
          return errorResponse(416, 'Range Not Satisfiable', { 'Content-Range': `bytes */${meta.size}` });
        }
        if (parsed.kind === 'valid') {
          const obj = await env.MODELS_BUCKET.get(entry.key, {
            range: { offset: parsed.start, length: parsed.length },
          });
          if (!obj) return errorResponse(404, 'Not Found');
          const headers = buildAssetHeaders(entry.contentType, obj.httpEtag);
          headers.set('Content-Range', `bytes ${parsed.start}-${parsed.end}/${meta.size}`);
          headers.set('Content-Length', String(parsed.length));
          return new Response(obj.body, { status: 206, headers });
        }
      }

      const obj = await env.MODELS_BUCKET.get(entry.key);
      if (!obj) return errorResponse(404, 'Not Found');
      const headers = buildAssetHeaders(entry.contentType, obj.httpEtag);
      headers.set('Content-Length', String(obj.size));
      return new Response(obj.body, { status: 200, headers });
    } catch (err) {
      console.error(JSON.stringify({ event: 'r2_fetch_error', key: entry.key, message: err instanceof Error ? err.message : String(err) }));
      return errorResponse(500, 'Internal Server Error');
    }
  },
};
