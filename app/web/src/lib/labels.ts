import type { Agent, ArtifactKind, EntityKind, ProfileTarget, Scope, Source, SourceKind } from "../../../shared/types";

export const SCOPE_LABEL: Record<Scope, string> = { personal: "Personal", finance: "Finance", health: "Health", household: "Household", private: "Private" };
export const TARGET_LABEL: Record<ProfileTarget, string> = {
  "crew-chief": "Crew Chief", "pitcrew-member": "Pitcrew members", "claude-code": "Claude Code", codex: "Codex",
};
export const TARGETS = Object.keys(TARGET_LABEL) as ProfileTarget[];
export const AGENT_KIND_LABEL: Record<Agent["kind"], string> = { pitcrew: "Pitcrew member", mac: "On the Mac", other: "Other" };

export const ARTIFACT_KIND_LABEL: Record<ArtifactKind, [string, string]> = {
  receipt: ["Receipt", "Receipts"], statement: ["Statement", "Statements"], report: ["Report", "Reports"],
  screenshot: ["Screenshot", "Screenshots"], plan: ["Plan answer", "Plan answers"], document: ["Document", "Documents"],
};
export const ENTITY_KIND_LABEL: Record<EntityKind, [string, string]> = {
  person: ["Person", "People"], place: ["Place", "Places"], account: ["Account", "Accounts"],
  document: ["Document", "Documents"], thing: ["Thing", "Things"],
};

const FROM: Record<SourceKind, string> = {
  you: "You", agent: "From an agent", email: "From an email", web: "From a web page", file: "From a file",
  calendar: "From your calendar", other: "From elsewhere",
};
export function fromLabel(s: Source): string {
  return FROM[s.kind] ?? "From elsewhere";
}

/** Crew hues come as "c1".."c6", a CSS colour, or nothing (Mac agents read as neutral). */
export function hueColor(hue: string | null | undefined): string {
  if (!hue) return "var(--ink-2)";
  if (/^c\d$/.test(hue)) return `var(--${hue})`;
  if (/^(#|rgb|hsl|var\()/.test(hue)) return hue;
  return "var(--ink-2)";
}

export function titleCase(slug: string): string {
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function fileTag(mime: string | null | undefined, title = ""): string {
  const m = (mime ?? "").toLowerCase();
  if (m.includes("pdf")) return "PDF";
  if (m.includes("png")) return "PNG";
  if (m.includes("jpeg") || m.includes("jpg")) return "JPG";
  if (m.includes("markdown")) return "MD";
  if (m.startsWith("image/")) return "IMG";
  if (m.startsWith("text/")) return "TXT";
  const ext = title.match(/\.([a-z0-9]{2,4})$/i)?.[1];
  return ext ? ext.toUpperCase() : "FILE";
}
