import type { Connection } from "../../../shared/types";
import { api } from "../lib/api";
import { useWho } from "../lib/directory";
import { href } from "../lib/router";
import { useLoad } from "../lib/useLoad";
import { BackLink, Card, CardHead, Dot, Empty, ErrorNote, H1, Lede, ListPane, Loading, Main, Split } from "../components/ui";

const M2 = "The gateway arrives next (M2). Connect Gmail, GitHub and others once, and grant each agent what it may use.";
const statusColor = (s: Connection["status"]) => (s === "signal" ? "var(--signal)" : s === "warn" ? "var(--warn)" : "var(--in)");

export function Connections({ id }: { id?: string }) {
  const load = useLoad(() => api.connections(), []);
  const list = load.data ?? [];
  const picked = list.find((c) => c.id === id) ?? (id ? undefined : list[0]);
  return (
    <Split picked={!!id}
      list={
        <ListPane title="Connections" sub="Engram holds the sign-ins. Agents never see them.">
          {!load.data && (load.error ? <ErrorNote error={load.error} onRetry={load.reload} /> : <Loading />)}
          {load.data && list.length === 0 && <p className="px-3 text-[13px] text-ink-3 leading-relaxed wide:hidden">{M2}</p>}
          {list.map((c) => (
            <a key={c.id} href={href(["connections", c.id])} className="it" aria-current={c.id === picked?.id ? "true" : undefined}>
              <Dot color={statusColor(c.status)} className="mt-[7px]" />
              <span><span className="block">{c.name}</span><span className="block text-[12.5px] text-ink-3 mt-0.5">{c.detail} · {c.tools.length} tools</span></span>
            </a>
          ))}
        </ListPane>
      }
      detail={
        <Main>
          {picked ? <Detail c={picked} /> : load.data ? (
            <>
              <H1>Connections</H1>
              <Card className="mt-6 max-w-[680px]">
                <Empty title="Nothing connected yet.">{M2}</Empty>
              </Card>
            </>
          ) : null}
        </Main>
      } />
  );
}

function Detail({ c }: { c: Connection }) {
  const who = useWho();
  const changed = c.tools.filter((t) => t.changed);
  return (
    <>
      <BackLink href="#/connections" label="Connections" />
      <p className="text-[13px] text-ink-3">{c.detail}</p>
      <H1 className="mt-3">{c.name}</H1>
      {changed.length > 0 && (
        <Card hot className="mt-5 px-5 py-4 flex items-center gap-3">
          <Dot color="var(--signal)" />
          <p className="flex-1">{changed.length === 1 ? "One tool description changed" : `${changed.length} tool descriptions changed`} since you approved {changed.length === 1 ? "it" : "them"}. Blocked for every agent until you look.</p>
        </Card>
      )}
      <Card className="mt-3">
        <CardHead left="Tools" right="read-only unless you say so" />
        {c.tools.length === 0 && <Lede className="px-5 pb-4">No tools reported yet.</Lede>}
        {c.tools.map((t) => (
          <div key={t.name} className="grid grid-cols-[1fr_auto] wide:grid-cols-[200px_70px_1fr_130px] gap-3 items-center px-[18px] py-[11px] border-t border-line text-[13px]">
            <span className="font-mono text-[12.5px]">{t.name}</span>
            <span className="text-ink-3 max-wide:hidden">{t.kind}</span>
            <span className="text-ink-2 max-wide:hidden">{t.agents.length ? t.agents.map((a) => who(a).name).join(", ") : "nobody"}</span>
            <span className="text-right" style={{ color: t.changed ? "var(--signal)" : "var(--ink-3)" }}>{t.changed ? "changed · blocked" : t.pinned ? "pinned" : "not pinned"}</span>
          </div>
        ))}
      </Card>
    </>
  );
}
