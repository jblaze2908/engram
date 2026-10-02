import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, UNAUTHORIZED } from "./lib/api";
import { App as AppContext, type AppCtx } from "./lib/app";
import { navigate, useRoute, type Route } from "./lib/router";
import { Rail, type Section } from "./components/Rail";
import { AddMemory } from "./components/AddMemory";
import { Login, Setup, Unreachable } from "./screens/Auth";
import { Inbox } from "./screens/Inbox";
import { Status } from "./screens/Status";
import { ContextHome } from "./screens/ContextHome";
import { AreaPage } from "./screens/Area";
import { People } from "./screens/People";
import { Memories } from "./screens/Memories";
import { Artifacts } from "./screens/Artifacts";
import { Journal } from "./screens/Journal";
import { Profile } from "./screens/Profile";
import { Trace } from "./screens/Trace";
import { Connections } from "./screens/Connections";
import { Skills } from "./screens/Skills";
import { Agents } from "./screens/Agents";
import { DigestPage } from "./screens/Digest";
import { Consent } from "./screens/Consent";
import { Empty, Main } from "./components/ui";

type Gate = { k: "loading" } | { k: "setup" } | { k: "login" } | { k: "ready" } | { k: "down"; error: string };

const INBOX_POLL_MS = 60_000;

export function App() {
  const [gate, setGate] = useState<Gate>({ k: "loading" });
  const route = useRoute();

  const check = useCallback(() => {
    api.session().then(
      (s) => setGate(!s.setup ? { k: "setup" } : s.authed ? { k: "ready" } : { k: "login" }),
      (e: Error) => setGate({ k: "down", error: e.message }),
    );
  }, []);

  useEffect(check, [check]);
  useEffect(() => {
    const on = () => setGate((g) => (g.k === "ready" ? { k: "login" } : g));
    window.addEventListener(UNAUTHORIZED, on);
    return () => window.removeEventListener(UNAUTHORIZED, on);
  }, []);

  if (gate.k === "loading") return null;
  if (gate.k === "setup") return <Setup onDone={check} />;
  if (gate.k === "login") return <Login onDone={check} />;
  if (gate.k === "down") return <Unreachable error={gate.error} onRetry={check} />;
  // /oauth/authorize parks the request and lands here; sign-in above comes first when needed.
  if (route.parts[0] === "consent") return <Consent id={route.parts[1] ?? ""} />;
  return <Shell />;
}

function Shell() {
  const route = useRoute();
  const [inbox, setInbox] = useState<number | null>(null);
  const [up, setUp] = useState(true);
  const [adding, setAdding] = useState<{ area?: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // One inbox list call a minute while the tab is visible; decisions refresh it immediately.
  const refreshInbox = useCallback(() => {
    api.inbox().then(
      (ps) => { setInbox(ps.filter((p) => p.status === "open").length); setUp(true); },
      (e: { status?: number }) => { if (e.status === 0) setUp(false); },
    );
  }, []);
  useEffect(() => {
    refreshInbox();
    const t = setInterval(() => { if (document.visibilityState === "visible") refreshInbox(); }, INBOX_POLL_MS);
    return () => clearInterval(t);
  }, [refreshInbox]);

  const notify = useCallback((text: string) => {
    setNotice(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);

  const ctx = useMemo<AppCtx>(() => ({ inbox, refreshInbox, openAdd: (area) => setAdding({ area }), notify }), [inbox, refreshInbox, notify]);

  useEffect(() => { if (route.parts.length === 0) navigate("#/status"); }, [route.parts.length]);

  const section = (route.parts[0] ?? "status") as Section;
  return (
    <AppContext.Provider value={ctx}>
      <div className="h-full flex flex-col wide:flex-row overflow-hidden">
        <Rail active={RAIL.has(section) ? section : null} inbox={inbox} up={up} onAdd={() => setAdding({})} />
        <div className="flex-1 min-w-0 min-h-0 flex overflow-y-auto wide:overflow-hidden pb-[72px] wide:pb-0">
          <Screen route={route} />
        </div>
      </div>
      <AddMemory open={!!adding} area={adding?.area} onClose={() => setAdding(null)}
        onAdded={(name) => { setAdding(null); notify(`Added to ${name}.`); }} />
      <div aria-live="polite" className="fixed z-30 bottom-[80px] wide:bottom-6 left-1/2 -translate-x-1/2 pointer-events-none">
        {notice && <p className="cd px-4 py-2.5 text-[13.5px] shadow-lg">{notice}</p>}
      </div>
    </AppContext.Provider>
  );
}

const RAIL = new Set<Section>(["inbox", "status", "context", "trace", "connections", "skills", "agents"]);

function Screen({ route }: { route: Route }) {
  const [a, b, c] = route.parts;
  const q = route.query;
  switch (a) {
    case undefined:
    case "status": return <Status />;
    case "inbox": return <Inbox id={b} />;
    case "trace": return <Trace query={q} />;
    case "connections": return <Connections id={b} query={q} />;
    case "skills": return <Skills name={b} />;
    case "agents": return <Agents id={b} />;
    case "digest": return <DigestPage week={q.get("week") ?? undefined} />;
    case "context":
      switch (b) {
        case undefined: return <ContextHome />;
        case "areas": return c ? <AreaPage slug={c} /> : <ContextHome />;
        case "people": return <People id={c} query={q} />;
        case "memories": return <Memories id={c} query={q} />;
        case "artifacts": return <Artifacts id={c} query={q} />;
        case "journal": return <Journal day={q.get("day") ?? undefined} />;
        case "profile": return <Profile query={q} />;
      }
  }
  return (
    <Main>
      <Empty title="There’s nothing at this address.">
        <a className="text-data hover:underline" href="#/status">Go to Status</a>
      </Empty>
    </Main>
  );
}
