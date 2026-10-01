import type { Memory } from "../../../shared/types";
import { api } from "../lib/api";
import { useApp } from "../lib/app";
import { useWho } from "../lib/directory";
import { clock, num, shortDate } from "../lib/format";
import { ENTITY_KIND_LABEL, fileTag } from "../lib/labels";
import { href } from "../lib/router";
import { useLoad } from "../lib/useLoad";
import { Breadcrumb, Btn, Card, CardHead, Dot, Empty, ErrorNote, H1, Lede, LinkBtn, Loading, Main } from "../components/ui";

export function sourceShort(m: Memory): string {
  const at = m.source.at ?? m.observed_at;
  return `${m.source.label}${at ? ` · ${shortDate(at)}` : ""}`;
}

export function AreaPage({ slug }: { slug: string }) {
  const { openAdd } = useApp();
  const who = useWho();
  const load = useLoad(() => api.area(slug), [slug]);
  const v = load.data;
  if (!v) return <Main>{load.error ? <ErrorNote error={load.error} onRetry={load.reload} /> : <Loading />}</Main>;
  const { area } = v;
  return (
    <Main>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Breadcrumb items={[{ label: "Context", href: "#/context" }, { label: area.name }]} />
        <span className="flex gap-2">
          <LinkBtn href={href(["context", "memories"], { area: slug })}>All {num(area.counts.memories)} memories</LinkBtn>
          <Btn onClick={() => openAdd(slug)}>Add to {area.name}</Btn>
        </span>
      </div>
      <H1 className="mt-3">{area.name}</H1>
      <Lede>{area.summary || `Nothing is known about ${area.name} yet.`}</Lede>

      {v.held.length > 0 && (
        <Card hot className="mt-6 px-5 py-3.5 flex items-center gap-3">
          <Dot color="var(--signal)" />
          <p className="flex-1 text-[13.5px]">
            {v.held.length === 1 ? `A held proposal: ${v.held[0].title}.` : `${v.held.length} held proposals touch ${area.name}.`} Nothing here uses {v.held.length === 1 ? "it" : "them"} until you decide.
          </p>
          <LinkBtn href={href(["inbox", v.held[0].id])}>Review</LinkBtn>
        </Card>
      )}

      <div className="grid grid-cols-1 wide:grid-cols-[1fr_340px] gap-3 mt-3 flex-1 min-h-0">
        <div className="flex flex-col gap-3 min-h-0">
          <Card>
            <CardHead left="Right now" right={`what agents read about ${area.name}`} />
            {v.now.length === 0 && <Empty className="border-t border-line">No memories in {area.name} yet. Add one yourself, or let an agent propose them; accepted ones show up here.</Empty>}
            {v.now.map((m) => (
              <a key={m.id} href={href(["context", "memories", m.id])}
                className="grid grid-cols-1 wide:grid-cols-[1fr_160px] gap-1 wide:gap-4 items-baseline px-[18px] py-3 border-t border-line hover:bg-surface-2">
                <span>{m.text}</span>
                <span className="text-[12px] text-ink-3 wide:text-right truncate">{sourceShort(m)}</span>
              </a>
            ))}
          </Card>
          <Card>
            <CardHead left="Lately" right={<a href="#/context/journal" className="hover:text-ink-2">Journal</a>} />
            {v.lately.length === 0 && <p className="rw text-ink-2">Nothing yet. What you and your agents do in {area.name} is written to the journal.</p>}
            {v.lately.map((e) => (
              <div key={e.id} className="grid grid-cols-[70px_1fr] gap-3 px-[18px] py-2.5 border-t border-line text-[13.5px]">
                <span className="font-mono text-[12px] text-ink-3 pt-[2px]">{new Date(e.at).toLocaleDateString("en-GB", { weekday: "short" })} {clock(e.at)}</span>
                <span><span className="text-ink-3">{who(e.who).name}</span> {e.text}</span>
              </div>
            ))}
          </Card>
        </div>
        <div className="flex flex-col gap-3">
          <Card>
            <CardHead left="People" right={v.people.length || undefined} />
            {v.people.length === 0 && <p className="rw text-ink-2">No people, places or accounts linked yet.</p>}
            {v.people.map((p) => (
              <a key={p.id} href={href(["context", "people", p.id])} className="rw hover:bg-surface-2">
                <span className="w-[28px] h-[28px] rounded-full flex-none grid place-items-center bg-surface-2 text-[12px] font-medium text-ink-2" aria-hidden="true">{p.name.slice(0, 1).toUpperCase()}</span>
                <div className="flex-1 min-w-0"><p>{p.name}</p><p className="text-[12.5px] text-ink-3">{p.summary || ENTITY_KIND_LABEL[p.kind]?.[0]}</p></div>
              </a>
            ))}
          </Card>
          <Card>
            <CardHead left="Files" right={v.files.length || undefined} />
            {v.files.length === 0 && <p className="rw text-ink-2">No files yet. Receipts, statements and documents an agent saves land here.</p>}
            {v.files.map((f) => (
              <a key={f.id} href={href(["context", "artifacts", f.id])} className="rw hover:bg-surface-2">
                <span className="w-[28px] h-[32px] rounded-[6px] flex-none grid place-items-center bg-surface-2 font-mono text-[9px] font-medium text-ink-2">{fileTag(f.mime, f.title)}</span>
                <span className="flex-1 min-w-0 truncate">{f.title}</span>
              </a>
            ))}
          </Card>
          <Card className="p-5">
            <p className="text-[13px] text-ink-3">Seen by</p>
            <p className="text-[13.5px] text-ink-2 mt-1.5">
              {v.readers.length ? `${v.readers.map((r) => who(r).name).join(", ")}.` : "No agent has read anything here yet."} Each agent sees only the scopes you grant it.
            </p>
          </Card>
        </div>
      </div>
    </Main>
  );
}
