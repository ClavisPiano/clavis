/**
 * Push services we deliver to. The Worker POSTs to the subscription endpoint, so any other host
 * would let a learner point our cron at a server of their choosing. A host matches a suffix when it
 * equals it or is a subdomain of it (Mozilla and Windows endpoints live on per-region subdomains).
 * Add a suffix here when a browser ships a new push service.
 */
export const PUSH_SERVICE_HOSTS = [
  "fcm.googleapis.com", // Chrome, Edge and other Chromium browsers
  "push.services.mozilla.com", // Firefox
  "web.push.apple.com", // Safari
  "notify.windows.com", // legacy Edge and Windows
] as const;

export function isPushServiceHost(host: string): boolean {
  const h = host.toLowerCase();
  return PUSH_SERVICE_HOSTS.some((suffix) => h === suffix || h.endsWith(`.${suffix}`));
}

/**
 * True for a plain https URL on a known push service: no credentials, no custom port, and a host
 * from `PUSH_SERVICE_HOSTS`.
 */
export function isAcceptableEndpoint(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return false;
  if (url.port !== "") return false;
  return isPushServiceHost(url.hostname);
}
