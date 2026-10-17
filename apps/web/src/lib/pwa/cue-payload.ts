export interface CuePayload {
  title: string;
  body: string;
  /** Same-origin path to open when the notification is tapped. */
  url: string;
}

export const FALLBACK_CUE: CuePayload = {
  title: "Time to practise",
  body: "Your short daily session is ready.",
  url: "/",
};

/**
 * Reads the push payload sent by the Worker. Anything missing or malformed gives the fallback,
 * because a push must always show a notification. The url is limited to a same-origin path.
 */
export function parseCuePayload(data: { json(): unknown } | null | undefined): CuePayload {
  let raw: unknown;
  try {
    raw = data?.json();
  } catch {
    return FALLBACK_CUE;
  }
  if (typeof raw !== "object" || raw === null) return FALLBACK_CUE;
  const r = raw as Record<string, unknown>;
  const text = (v: unknown, fallback: string): string =>
    typeof v === "string" && v.trim() !== "" ? v.slice(0, 200) : fallback;
  const url = typeof r.url === "string" && /^\/(?!\/)/.test(r.url) ? r.url : FALLBACK_CUE.url;
  return {
    title: text(r.title, FALLBACK_CUE.title),
    body: text(r.body, FALLBACK_CUE.body),
    url,
  };
}
