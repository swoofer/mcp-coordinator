/**
 * Direct fetch — no automatic cookie jar, no CSRF auto-injection. The T40
 * SDK wraps fetch with CSRF cookie handling for HTML form-style POSTs;
 * rawFetch bypasses that so tests can verify the low-level HTTP contract
 * (e.g. a request without the CSRF cookie is rejected by the server).
 */
export async function rawFetch(
  method: string,
  url: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<Response> {
  return fetch(url, {
    method,
    headers: opts.headers,
    body: opts.body,
  });
}
