import { fetchBypass, type FetchMode } from '../extractors/fetch-bypass.js';

const SECRET = process.env.FETCH_SHARED_SECRET;

export interface FetchRouteBody {
  url: string;
  referer?: string;
  country?: string;
  proxy?: boolean;
  render?: boolean;
  headers?: Record<string, string>;
  mode?: FetchMode;
}

export async function handleFetchRoute(req: Request): Promise<Response> {
  const start = Date.now();

  if (!SECRET) {
    return jsonErr(503, 'FETCH_SHARED_SECRET not configured on server', start);
  }

  const auth = req.headers.get('authorization') ?? '';
  const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!timingSafeEqualStr(presented, SECRET)) {
    return jsonErr(401, 'invalid bearer token', start);
  }

  let body: FetchRouteBody;
  try {
    body = (await req.json()) as FetchRouteBody;
  } catch {
    return jsonErr(400, 'invalid JSON body', start);
  }

  if (!body || typeof body.url !== 'string' || body.url.length === 0) {
    return jsonErr(400, 'field "url" is required', start);
  }

  try {
    const html = await fetchBypass(body.url, {
      referer: body.referer,
      mode: body.mode,
      headers: body.headers,
      forceProxy: body.proxy,
      country: body.country,
      render: body.render,
    });
    const ms = Date.now() - start;
    console.log(JSON.stringify({
      event: 'fetch_route_ok',
      url: body.url,
      bytes: html.length,
      ms,
      proxy: body.proxy === true,
      country: body.country ?? null,
      timestamp: new Date().toISOString(),
    }));
    return new Response(
      JSON.stringify({ ok: true, body: html, bytes: html.length, ms }),
      { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const ms = Date.now() - start;
    const lower = message.toLowerCase();
    const status = lower.includes('timeout') || lower.includes('etimedout') ? 504 : 502;
    console.error(JSON.stringify({
      event: 'fetch_route_failed',
      url: body.url,
      error: message,
      ms,
      timestamp: new Date().toISOString(),
    }));
    return new Response(
      JSON.stringify({ ok: false, error: message, ms }),
      { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
    );
  }
}

// Length-aware constant-time comparison. We can't use crypto.timingSafeEqual
// directly because it requires equal-length buffers (early-exit on mismatch
// would leak length). Compare against a fixed-length digest of both inputs.
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const aBuf = new TextEncoder().encode(a);
  const bBuf = new TextEncoder().encode(b);
  const len = Math.max(aBuf.length, bBuf.length);
  let diff = aBuf.length ^ bBuf.length;
  for (let i = 0; i < len; i++) {
    diff |= (aBuf[i] ?? 0) ^ (bBuf[i] ?? 0);
  }
  return diff === 0;
}

function jsonErr(status: number, error: string, start: number): Response {
  return new Response(
    JSON.stringify({ ok: false, error, ms: Date.now() - start }),
    { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
  );
}
