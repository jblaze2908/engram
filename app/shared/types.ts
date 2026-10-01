// The API's data shapes, shared by the server (app/src) and the web app (app/web). JSON over the wire, so times are
// epoch milliseconds. Extend here, not in either side, so a renamed field breaks the build.

export type Scope = "personal" | "finance" | "health" | "private";
export const SCOPES: Scope[] = ["personal", "finance", "health", "private"];

/** Where a record came from. Email bodies and web pages are untrusted: anything derived from them is held for review. */
export type SourceKind = "you" | "agent" | "email" | "web" | "file" | "calendar" | "other";
export interface Source {
  kind: SourceKind;
  /** Human label, e.g. "Airtel bill PDF, 28 Sep" or "Re: October rent". */
  label: string;
  /** Agent id that read or wrote it, when an agent was involved. */
  agent?: string | null;
  /** Pointer to the origin: an artifact id, a URL, a message id. */
  ref?: string | null;
  at?: number | null;
}
export const UNTRUSTED: SourceKind[] = ["email", "web"];

// ---------- the vault (markdown files are the source of truth; SQLite indexes them) ----------

export interface Area { slug: string; name: string; summary: string; counts: { memories: number; files: number; people: number }; held: number; runningOut: number }
export interface Project { slug: string; name: string; area: string; summary: string; status: "open" | "done"; ends?: string | null }

/** A memory (the spec calls it a fact): one claim, with a source and a validity window. Append-only; corrections supersede. */
export type MemoryStatus = "active" | "superseded" | "held" | "forgotten";
export interface Memory {
  id: string; text: string; area: string; project?: string | null; entities: string[]; scope: Scope;
  source: Source; trust: "trusted" | "untrusted"; status: MemoryStatus;
  observed_at: number; valid_from?: string | null; valid_until?: string | null;
  supersedes?: string | null; superseded_by?: string | null;
  created_at: number; accepted_at?: number | null; reads: number;
}

export type EntityKind = "person" | "place" | "account" | "document" | "thing";
export interface Entity { id: string; kind: EntityKind; name: string; summary: string; area: string; scope: Scope; memories: number; held: number }
export interface EntityView { entity: Entity; memories: Memory[]; linked: { kind: string; id: string; label: string }[]; readers: { agent: string; count: number }[] }

export type ArtifactKind = "receipt" | "statement" | "report" | "screenshot" | "plan" | "document";
export interface Artifact {
  id: string; title: string; kind: ArtifactKind; area: string; scope: Scope; source: Source;
  mime?: string | null; size?: number | null; sha256?: string | null; kept: boolean; url?: string | null;
  created_at: number; memories: string[];
}

/** A journal entry (the spec calls it an episode): what you or an agent did. Describes, never asserts. */
export interface Episode { id: string; at: number; who: string; text: string; area: string; project?: string | null; outputs: { kind: string; ref: string; label: string }[] }

export interface Skill { name: string; description: string; area: string; body: string; version: number; agents: string[]; updated_at: number; uses7d: number; pending: number }
export interface ProfileFile { name: string; scope: Scope; lines: number; body: string }
export type ProfileTarget = "crew-chief" | "pitcrew-member" | "claude-code" | "codex";
export interface CompiledProfile { target: ProfileTarget; text: string; lines: number; budget: number; lint: { file: string; line: number; message: string }[] }

// ---------- agents, grants and the write path ----------

export interface Grant { scope: Scope; read: boolean; write: "none" | "propose" }
export interface Agent {
  id: string; name: string; kind: "pitcrew" | "mac" | "other"; profile: ProfileTarget;
  /** Crew hue for Pitcrew members, else null. */
  hue?: string | null; grants: Grant[]; skills: string[]; tools?: ToolGrant[];
  /** May use the Pitcrew link API (one per install). */
  link?: boolean;
  token_prefix: string; created_at: number; last_used_at?: number | null; revoked: boolean;
}
/** Returned once when a token is created or rotated; only its hash is stored. */
export interface NewToken { agent: Agent; token: string }

/** vault_conflict: Obsidian and Engram both changed a vault file (vault sync); accept takes the Obsidian version. */
export type ProposalKind = "memory" | "entity" | "artifact" | "skill" | "tool_change" | "vault_conflict";
export interface Proposal {
  id: string; kind: ProposalKind; agent: string | null; title: string; scope: Scope; area: string;
  /** The proposed record as it would be stored. */
  data: Record<string, unknown>;
  source: Source;
  /** Plain-sentence reasons it is held, e.g. "Email content is never trusted on its own". Empty when only awaiting review. */
  reasons: string[];
  held: boolean;
  replaces?: { id: string; text: string; source: Source } | null;
  status: "open" | "accepted" | "rejected";
  created_at: number; decided_at?: number | null;
}
export type Decision = "accept" | "keep" | "reject" | "reject_and_forget_source";

export interface TraceRow { id: number; at: number; who: string; action: string; target: string; scope?: Scope | null; result: "ok" | "refused" | "held" | "blocked" | "error"; detail?: string | null }
export interface Provenance { memory: Memory; steps: { at: number | null; text: string; detail: string }[] }

// ---------- screens ----------

/** `setup` is true once a password exists; the web app shows Setup while it is false. */
export interface Session { setup: boolean; authed: boolean }
export interface Status {
  up_since: number; calls_today: number; refused_today: number; calls_by_hour: number[];
  memories: number; new_this_week: number; last_index: number | null; last_backup: number | null;
  pitcrew_linked: boolean; inbox: { open: number; held: number };
  attention: { level: "signal" | "warn"; title: string; detail: string; action: string; href: string }[];
  agents: { id: string; name: string; hue?: string | null; last_used_at: number | null; calls_today: number }[];
}
export interface ContextHome {
  you: { files: number; targets: number; lint: number; highlights: string[] };
  areas: Area[]; projects: Project[];
  changed: { text: string; detail: string; tone: "normal" | "bad" }[];
  runningOut: { date: string; text: string; area: string }[];
  counts: { people: number; memories: number; artifacts: number; journalWeek: number; skills: number };
}
export interface AreaView {
  area: Area; now: Memory[]; people: Entity[]; files: Artifact[]; lately: Episode[]; held: Proposal[]; readers: string[];
}
export interface JournalDay { day: string; count: number }
export interface JournalView { days: JournalDay[]; day: string; entries: Episode[]; week: string[] }

/** Upstream MCP connections arrive with milestone M2 (the gateway); the API returns an empty list until then. */
export interface Connection { id: string; name: string; status: "ok" | "warn" | "signal"; detail: string; tools: { name: string; kind: "read" | "write"; agents: string[]; pinned: boolean; changed: boolean }[] }

// ---------- M2 gateway ----------

/** How Engram signs in to an upstream MCP server. Credentials are stored encrypted (AES-256-GCM, master.key) and never leave the server. */
export type ConnectionAuth = "oauth" | "bearer" | "none";
export interface ConnectionTool { name: string; kind: "read" | "write"; description: string; agents: string[]; pinned: boolean; changed: boolean }
export interface ConnectionDetail extends Connection {
  url: string; auth: ConnectionAuth; untrusted: boolean; connected_at: number | null; refreshed_at: number | null;
  tools: ConnectionTool[]; changes: { tool: string; approved: string; now: string }[];
}
/** An agent's access to one upstream tool, written "<connection>/<tool>". Write tools are never granted by default. */
export type ToolGrant = string;

// ---------- M3 Pitcrew link, M4 digest ----------

/** What Pitcrew needs to mirror Engram: open proposals (never private scope) and the current digest. */
export interface LinkInbox { proposals: Proposal[]; at: number }
export interface Digest {
  week: string; from: string; to: string; built_at: number;
  waiting: { open: number; held: number };
  runningOut: { date: string; text: string; area: string }[];
  changed: { text: string; detail: string; tone: "normal" | "bad" }[];
  openLoops: { text: string; area: string }[];
  journal: { day: string; lines: string[] }[];
}
export interface LinkMember { pitcrew_id: string; name: string; hue?: string | null; area?: string | null }

// ---------- M5 sync ----------

/** What a Mac or Pitcrew agent writes to disk: the skills granted to it and its compiled profile block. */
export interface SyncBundle { agent: string; profile: CompiledProfile; skills: { name: string; version: number; body: string }[]; at: number }
