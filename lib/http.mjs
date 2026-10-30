export function fetchWithTimeout(fetchImpl = fetch, url, options = {}, timeoutMs = 120_000) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  return fetchImpl(url, { ...options, signal });
}
