import type {
  Agent, AreaView, Artifact, ArtifactKind, CatalogEntry, CompiledProfile, ConnectionAuth, Connection, ConnectionDetail, ConnectResult, ContextHome, Decision, Digest, Entity, EntityKind,
  EntityView, Grant, JournalView, Memory, MemoryStatus, NewConnection, NewToken, OAuthClient, OAuthConsent, ProfileFile, ProfileTarget, Proposal, Provenance,
  Scope, Session, Skill, Status, ToolPolicy, TraceRow,
} from "../../../shared/types";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Fired on any 401 so the app can drop back to the login screen. */
export const UNAUTHORIZED = "engram:unauthorized";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  // The server requires this header on cookie-authed mutations (CSRF guard; a cross-site form can't set it).
  if (method !== "GET") headers["x-engram"] = "1";
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, { method, headers, credentials: "same-origin", body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, "Engram can’t be reached. Check the connection and try again.");
  }
  if (res.status === 401 && !path.startsWith("/api/login") && !path.startsWith("/api/setup")) {
    window.dispatchEvent(new Event(UNAUTHORIZED));
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const msg = data && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string"
      ? (data as { error: string }).error
      : res.status === 401 ? "Sign in to continue."
      : res.status >= 502 && res.status <= 504 ? "Engram can’t be reached. Check the server is running and try again."
      : `Something went wrong (${res.status}).`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

function qs(params: Record<string, string | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}

const enc = encodeURIComponent;

export interface NewAgent { name: string; kind: Agent["kind"]; profile: ProfileTarget; grants: Grant[] }
export interface NewMemory { text: string; area: string; scope: Scope; valid_until?: string | null }

export const api = {
  health: () => request<unknown>("GET", "/healthz"),
  session: () => request<Session>("GET", "/api/session"),
  setup: (token: string, password: string) => request<unknown>("POST", "/api/setup", { token, password }),
  login: (password: string) => request<unknown>("POST", "/api/login", { password }),
  logout: () => request<unknown>("POST", "/api/logout"),

  status: () => request<Status>("GET", "/api/status"),
  inbox: () => request<Proposal[]>("GET", "/api/inbox"),
  decide: (id: string, decision: Decision) => request<unknown>("POST", `/api/inbox/${enc(id)}`, { decision }),

  context: () => request<ContextHome>("GET", "/api/context"),
  area: (slug: string) => request<AreaView>("GET", `/api/areas/${enc(slug)}`),
  entities: (kind?: EntityKind) => request<Entity[]>("GET", `/api/entities${qs({ kind })}`),
  entity: (id: string) => request<EntityView>("GET", `/api/entities/${enc(id)}`),

  memories: (f: { status?: MemoryStatus; area?: string; q?: string } = {}) =>
    request<Memory[]>("GET", `/api/memories${qs(f)}`),
  memory: (id: string) => request<Memory>("GET", `/api/memories/${enc(id)}`),
  forgetMemory: (id: string) => request<unknown>("POST", `/api/memories/${enc(id)}/forget`),
  provenance: (id: string) => request<Provenance>("GET", `/api/memories/${enc(id)}/provenance`),
  addMemory: (m: NewMemory) => request<Memory>("POST", "/api/memories", m),

  artifacts: (kind?: ArtifactKind) => request<Artifact[]>("GET", `/api/artifacts${qs({ kind })}`),
  artifact: (id: string) => request<Artifact>("GET", `/api/artifacts/${enc(id)}`),
  artifactFileUrl: (id: string) => `/api/artifacts/${enc(id)}/file`,

  journal: (day?: string) => request<JournalView>("GET", `/api/journal${qs({ day })}`),
  profile: () => request<{ files: ProfileFile[]; compiled: CompiledProfile[] }>("GET", "/api/profile"),
  skills: () => request<Skill[]>("GET", "/api/skills"),
  skill: (name: string) => request<Skill>("GET", `/api/skills/${enc(name)}`),

  agents: () => request<Agent[]>("GET", "/api/agents"),
  createAgent: (a: NewAgent) => request<NewToken>("POST", "/api/agents", a),
  updateAgent: (id: string, patch: Partial<Pick<Agent, "grants" | "skills" | "name">>) =>
    request<Agent>("PATCH", `/api/agents/${enc(id)}`, patch),
  newToken: (id: string) => request<NewToken>("POST", `/api/agents/${enc(id)}/token`),
  revoke: (id: string) => request<unknown>("POST", `/api/agents/${enc(id)}/revoke`),
  linkPitcrew: () => request<NewToken>("POST", "/api/link"),
  digest: (week?: string) => request<Digest>("GET", `/api/digest${qs({ week })}`),
  digestWeeks: () => request<string[]>("GET", "/api/digest/weeks"),

  trace: (f: { who?: string; result?: TraceRow["result"]; day?: string } = {}) =>
    request<TraceRow[]>("GET", `/api/trace${qs(f)}`),
  connections: () => request<Connection[]>("GET", "/api/connections"),
  connection: (id: string) => request<ConnectionDetail>("GET", `/api/connections/${enc(id)}`),
  addConnection: (c: NewConnection & { id?: string }) => request<ConnectResult>("POST", "/api/connections", c),
  updateConnection: (id: string, patch: { untrusted?: boolean; token?: string }) => request<ConnectResult>("PATCH", `/api/connections/${enc(id)}`, patch),
  connect: (id: string) => request<ConnectResult>("POST", `/api/connections/${enc(id)}/connect`),
  refreshConnection: (id: string) => request<ConnectResult>("POST", `/api/connections/${enc(id)}/refresh`),
  disconnect: (id: string) => request<unknown>("DELETE", `/api/connections/${enc(id)}`),
  finishOAuth: (p: { state: string; code: string; iss?: string }) => request<ConnectResult>("POST", "/api/connections/oauth/finish", p),
  setToolKind: (id: string, tool: string, kind: "read" | "write" | null) => request<ConnectResult>("PATCH", `/api/connections/${enc(id)}/tools/${enc(tool)}`, { kind }),
  approveTool: (id: string, tool: string) => request<ConnectResult>("POST", `/api/connections/${enc(id)}/tools/${enc(tool)}/approve`),
  keepBlocked: (id: string, tool: string) => request<ConnectResult>("POST", `/api/connections/${enc(id)}/tools/${enc(tool)}/keep`),
  setToolPolicy: (id: string, tool: string, policy: ToolPolicy | null) => request<ConnectResult>("PATCH", `/api/connections/${enc(id)}/tools/${enc(tool)}`, { policy }),
  catalog: (q: string) => request<CatalogEntry[]>("GET", `/api/catalog${qs({ q })}`),
  probe: (url: string) => request<{ auth: ConnectionAuth; dcr: boolean | null; scopes: string[] }>("POST", "/api/catalog/probe", { url }),
  callArgs: (proposal: string) => request<{ call: string; status: string; args: Record<string, unknown> | null }>("GET", `/api/calls/${enc(proposal)}`),
  setAgentTools: (id: string, tools: string[]) => request<Agent>("PUT", `/api/agents/${enc(id)}/tools`, { tools }),

  memoriesByIds: (ids: string[]) => request<Memory[]>("GET", `/api/memories${qs({ ids: ids.join(",") })}`),
  editMemory: (id: string, text: string, valid_until?: string | null) => request<Memory>("POST", `/api/memories/${enc(id)}/edit`, { text, valid_until }),
  markWrong: (id: string, reason: string) => request<Memory>("POST", `/api/memories/${enc(id)}/wrong`, { reason }),
  forgetArtifact: (id: string) => request<{ id: string; memories: number }>("POST", `/api/artifacts/${enc(id)}/forget`),
  linkToProfile: (proposal: string, file: string) => request<unknown>("POST", `/api/inbox/${enc(proposal)}/link-profile`, { file }),
  oauthClients: () => request<OAuthClient[]>("GET", "/api/oauth/clients"),
  revokeOAuthClient: (id: string) => request<unknown>("POST", `/api/oauth/clients/${enc(id)}/revoke`),
  consent: (id: string) => request<OAuthConsent>("GET", `/api/oauth/requests/${enc(id)}`),
  approveConsent: (id: string, p: { grants: Grant[]; profile: ProfileTarget }) => request<{ redirect: string }>("POST", `/api/oauth/requests/${enc(id)}/approve`, p),
  denyConsent: (id: string) => request<{ redirect: string }>("POST", `/api/oauth/requests/${enc(id)}/deny`),
  undoAccept: (proposal: string) => request<{ forgotten: Memory; restored: Memory | null }>("POST", `/api/inbox/${enc(proposal)}/undo`),
};
