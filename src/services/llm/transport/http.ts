/**
 * Minimal HTTP transport — Phase 5.
 * Thin wrapper around native fetch, no protocol/provider awareness.
 * Auth/headers are prepared by caller (Route/Protocol), transport just executes.
 */
export type HttpRequest = {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: BodyInit | null
  signal?: AbortSignal
}

export async function httpRequest(
  req: HttpRequest,
  fetchOverride?: typeof fetch,
): Promise<Response> {
  const fetchFn = fetchOverride ?? (globalThis.fetch as typeof fetch)
  return fetchFn(req.url, {
    method: req.method ?? 'POST',
    headers: req.headers,
    body: req.body ?? null,
    signal: req.signal,
  })
}
