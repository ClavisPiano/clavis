/** How long a navigation waits for the network before the cached shell is used instead. */
export const NAVIGATE_TIMEOUT_MS = 3000;

/**
 * Network first with a deadline. Resolves with the network response, or with `fallback()` when the
 * request fails or has not answered within `timeoutMs` (a weak connection that never errors).
 * The late response is dropped; the browser still has the request in flight, which is harmless.
 */
export async function networkFirst<T>(
  network: () => Promise<T>,
  fallback: () => Promise<T>,
  timeoutMs: number = NAVIGATE_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      resolve("timeout");
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([network(), timeout]);
    return result === "timeout" ? await fallback() : result;
  } catch {
    return await fallback();
  } finally {
    clearTimeout(timer);
  }
}
