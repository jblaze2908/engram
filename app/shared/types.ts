// The API's data shapes, shared by the server (app/src) and the web app (app/web). JSON over the wire, so times are
// epoch milliseconds. Extend here, not in either side, so a renamed field breaks the build.

/** household: addresses, account last-4s, family. Read only by agents granted it by name; never a default grant. */
export type Scope = "personal" | "finance" | "health" | "household" | "private";
export const SCOPES: Scope[] = ["personal", "finance", "health", "household", "private"];

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
  /** Connections the proposing agent called in the 10 minutes before: what forget-by-connection removes. */
  connections?: string[];
}

export type EntityKind = "person" | "place" | "account" | "document" | "thing";
export interface Entity { id: string; kind: EntityKind; name: string; summary: string; area: string; scope: Scope; memories: number; held: number }
export interface EntityView { entity: Entity; memories: Memory[]; linked: { kind: string; id: string; label: string }[]; readers: { agent: string; count: number }[] }

export type ArtifactKind = "receipt" | "statement" | "report" | "screenshot" | "plan" | "document";
/** One published version of an artifact's file; the current one is the last. */
export interface ArtifactVersion { v: number; sha256: string; ext: string; mime: string; size: number | null; at: number; by: string }
/** A single file, private by default: url opens it for you on the artifacts host; public_url, when set, opens it for anyone. */
export interface Artifact {
  id: string; title: string; kind: ArtifactKind | string; area: string; project?: string | null; scope: Scope; source: Source; description?: string;
  versions: ArtifactVersion[]; version: number; mime?: string | null; size?: number | null; sha256?: string | null; kept: boolean;
  url: string; public_url: string | null; created_at: number; updated_at?: number; memories: string[];
}
export interface PublishResult { id: string; version: number; url: string; public_url: string | null; status: "published" | "share_pending" }

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
  /** Its memories and entities are accepted without the inbox when nothing flags them (spec §17). */
  auto_accept?: boolean;
  token_prefix: string; created_at: number; last_used_at?: number | null; revoked: boolean;
}
/** Returned once when a token is created or rotated; only its hash is stored. */
export interface NewToken { agent: Agent; token: string }

/** vault_conflict: Obsidian and Engram both changed a vault file (vault sync); accept takes the Obsidian version. */
export type ProposalKind = "memory" | "entity" | "artifact" | "skill" | "tool_change" | "vault_conflict" | "tool_call" | "share";
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
  /** Only in the answer to deciding a share: the public link it made (slugs are never stored on the proposal). */
  public_url?: string | null;
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
export interface ConnectionTool { name: string; kind: "read" | "write"; policy: ToolPolicy; description: string; agents: string[]; pinned: boolean; changed: boolean }
export interface ConnectionDetail extends Connection {
  url: string; auth: ConnectionAuth; untrusted: boolean; connected_at: number | null; refreshed_at: number | null;
  tools: ConnectionTool[]; changes: { tool: string; approved: string; now: string }[];
  /** Active memories an agent saved within 10 minutes of calling this connection. */
  memories: number;
}
/** An agent's access to one upstream tool, written "<connection>/<tool>". Write tools are never granted by default. */
export type ToolGrant = string;
export interface NewConnection { name: string; url: string; auth: ConnectionAuth; untrusted: boolean; token?: string; client_id?: string; client_secret?: string }
/** authorize_url is set when an OAuth connection needs you to sign in: open it, and the callback finishes the connect. */
export interface ConnectResult { connection: ConnectionDetail; authorize_url: string | null }
/** Vault path for "Open in Obsidian" (M1 leftover), merged into the interfaces above. */
export interface Memory { path?: string }
export interface Artifact { path?: string }

// ---------- M3 Pitcrew link, M4 digest ----------

/** An artifact a Pitcrew member published, as Pitcrew lists it. ref: the thread it came from ("pitcrew:thread:<id>"). */
export interface LinkArtifact {
  id: string; title: string; kind: string; pitcrew_id: string; version: number; mime: string | null; size: number | null;
  url: string; public_url: string | null; share_pending: boolean; ref: string | null; created_at: number; updated_at: number;
}
export interface LinkArtifactFilter {
  q?: string; member?: string; status?: "public" | "waiting" | "private"; kind?: "page" | "pdf" | "image" | "other";
  imported?: boolean; cursor?: { at: number; id: string }; limit?: number;
}
/** counts cover every member and filter: total (published from threads), waiting (a public link waits for you), imported. */
export interface LinkArtifactPage { artifacts: LinkArtifact[]; next: string | null; counts: { total: number; waiting: number; imported: number } }
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
/** scope: the member's home scope (default personal). connections: read tools granted once, when the agent is created. */
export interface LinkMember { pitcrew_id: string; name: string; hue?: string | null; area?: string | null; scope?: "personal" | "finance" | "health"; connections?: string[];
  /** Read household facts; applied when the member is created (POST /link/members/:id/household changes it later). */
  household?: boolean }
/** One of a member's own memories as Pitcrew shows it (source is the label). */
export interface LinkMemory { id: string; text: string; scope: Scope; area: string; created_at: number; source: string }
export interface LinkConnection { id: string; name: string; status: "ok" | "warn" | "signal"; detail: string; read: number; write: number }

// ---------- M5 sync ----------

/** What Pitcrew puts in a member's instructions: its compiled profile and the names of skills it may load with get(). Nothing is written to disk. */
export interface SyncBundle { agent: string; profile: CompiledProfile; skills: { name: string; description: string; version: number }[]; connections: { id: string; name: string }[];
  /** The member's own active memories, newest first (≤60), and its home scope. */
  memories: { id: string; text: string }[]; scope: Scope; household: boolean; at: number }

// ---------- batch 2: catalog, approval gate, OAuth server ----------

/** A remote MCP server you can add in one step: hand-picked, or found in the official MCP Registry. */
export interface CatalogEntry {
  id: string; name: string; description: string; url: string; auth: ConnectionAuth;
  /** Offers dynamic client registration, so OAuth needs nothing pasted. */
  dcr?: boolean | null; untrusted: boolean; docs?: string | null; tokenHelp?: string | null; icon?: string | null;
  source: "curated" | "registry"; connected?: boolean;
  /** Registry only: the publisher's namespace, and whether it owns the URL's host (e.g. com.notion → mcp.notion.com). */
  publisher?: string | null; verified?: boolean;
}
/** Per upstream tool: run, hold for your approval, or refuse. Write tools default to ask. */
export type ToolPolicy = "allow" | "ask" | "block";
/** An OAuth client that connected itself to Engram (ChatGPT, claude.ai…); each maps to one Engram agent. */
export interface OAuthClient { client_id: string; name: string; redirect_uris: string[]; agent: string; created_at: number; last_used_at?: number | null }
/** A pending /oauth/authorize request, as the consent screen shows it. agent is set when this client already has a live agent. */
export interface OAuthConsent { id: string; client_id: string; name: string; redirect_uri: string; redirect_host: string; agent: Agent | null; expires_at: number }
