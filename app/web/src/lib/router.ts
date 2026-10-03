import { useEffect, useState } from "react";

// Hash routing keeps the server's job to "serve index.html at /": no deep-link fallback needed.
export interface Route { parts: string[]; query: URLSearchParams }

function parse(): Route {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [path, search = ""] = raw.split("?");
  const parts = path.split("/").filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
  return { parts, query: new URLSearchParams(search) };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function href(parts: (string | null | undefined)[], query?: Record<string, string | null | undefined>): string {
  const path = parts.filter((p): p is string => !!p).map(encodeURIComponent).join("/");
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v) q.set(k, v);
  const s = q.toString();
  return `#/${path}${s ? `?${s}` : ""}`;
}

export function navigate(to: string): void {
  if (window.location.hash !== to) window.location.hash = to;
}

/** Like navigate, without a history entry per keystroke (search boxes). */
export function replace(to: string): void {
  if (window.location.hash === to) return;
  history.replaceState(null, "", to);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}
