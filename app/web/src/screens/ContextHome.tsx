import { api } from "../lib/api";
import { useApp } from "../lib/app";
import { useAreaName } from "../lib/directory";
import { daysUntil, num, plural, shortDate } from "../lib/format";
import { href, navigate } from "../lib/router";
import { useLoad } from "../lib/useLoad";
import { Btn, Card, CardHead, Dot, Empty, ErrorNote, Loading, Main, SearchField } from "../components/ui";

export function ContextHome() {
  const { openAdd } = useApp();
  const areaName = useAreaName();
  const load = useLoad(() => api.context(), []);
  const c = load.data;
  return (
    <Main className="wide:pb-7">
      <div className="flex items-center gap-4 flex-wrap">
        <h1 className="text-[30px] font-semibold tracking-[-0.025em]">Context</h1>
        <SearchField className="order-last wide:order-none basis-full wide:basis-auto flex-1 wide:max-w-[520px] wide:ml-6" label="Search everything Engram knows"
          placeholder="Search everything Engram knows" onSubmit={(q) => q && navigate(href(["context", "memories"], { q }))} />
        <Btn className="ml-auto" onClick={() => openAdd()}>Add to Engram</Btn>
      </div>
      {!c ? (load.error ? <ErrorNote error={load.error} onRetry={load.reload} /> : <Loading />) : (
        <div className="grid grid-cols-1 wide:grid-cols-[1fr_340px] gap-3 mt-6 flex-1 min-h-0">
          <div className="flex flex-col gap-3 min-h-0">
            <a href="#/context/profile" className="cd px-5 py-4 grid grid-cols-1 wide:grid-cols-[220px_1fr] gap-4 wide:gap-6 hover:border-line-2">
              <div>
                <p className="text-[13px] text-ink-3">You</p>
                <p className="text-[18px] font-semibold mt-1">How you work</p>
                <p className="text-[12.5px] text-ink-3 mt-1">
                  {plural(c.you.files, "file")} · sent to {plural(c.you.targets, "agent")}{c.you.lint ? ` · ${c.you.lint} lint` : ""}
                </p>
              </div>
              <div>
                {c.you.highlights.length === 0 ? (
                  <p className="text-[13.5px] text-ink-2">Your profile files are empty. Write how you work, your voice and your rules in them, and each agent gets a compiled copy.</p>
                ) : c.you.highlights.slice(0, 3).map((h, i) => (
                  <p key={i} className={`text-[13.5px] text-ink-2 py-[7px] ${i ? "border-t border-line" : "pt-0"}`}>{h}</p>
                ))}
              </div>
            </a>

            <p className="text-[13px] text-ink-3 mt-2 px-1">Areas · ongoing parts of your life</p>
            {c.areas.length === 0 ? <Card><Empty>No areas yet. Engram seeds Home, Money, Health, Car, Travel and Building on first boot.</Empty></Card> : (
              <div className="grid grid-cols-1 wide:grid-cols-3 gap-3">
                {c.areas.map((a) => (
                  <a key={a.slug} href={href(["context", "areas", a.slug])} className="cd px-[18px] py-4 flex flex-col gap-1.5 hover:border-line-2">
                    <h3 className="text-[16px] font-semibold tracking-[-0.01em]">{a.name}</h3>
                    <p className="text-[13px] text-ink-2 leading-[1.45]">{a.summary || "Nothing here yet."}</p>
                    <p className="text-[12px] text-ink-3 mt-auto pt-2 flex gap-2.5 items-center flex-wrap">
                      <span>{plural(a.counts.memories, "memory", "memories")}</span>
                      <span>{plural(a.counts.files, "file")}</span>
                      {a.held > 0 && <span className="flex items-center gap-1.5 text-signal"><Dot color="var(--signal)" />{a.held} held</span>}
                      {a.runningOut > 0 && <span className="flex items-center gap-1.5 text-warn"><Dot color="var(--warn)" />{a.runningOut} running out</span>}
                    </p>
                  </a>
                ))}
              </div>
            )}

            <p className="text-[13px] text-ink-3 mt-2 px-1">Projects · things that end</p>
            <Card>
              {c.projects.length === 0 && <Empty>No projects yet. A project is something with an end, like a trip or a renewal. Add one as a file in the vault’s projects folder.</Empty>}
              {c.projects.map((p, i) => {
                const left = p.ends ? daysUntil(p.ends) : null;
                return (
                  <div key={p.slug} className={`grid grid-cols-[1fr_auto] gap-3 items-center px-[18px] py-3 ${i ? "border-t border-line" : ""}`}>
                    <div className="min-w-0">
                      <p>{p.name} <span className="text-ink-3">· {areaName(p.area)}</span></p>
                      {p.summary && <p className="text-[12.5px] text-ink-3 mt-0.5">{p.summary}</p>}
                    </div>
                    <span className={`text-[12.5px] ${left !== null && left >= 0 && left <= 21 && p.status === "open" ? "text-warn" : "text-ink-3"}`}>
                      {p.status === "done" ? "done" : p.ends ? `by ${shortDate(p.ends)}` : "open"}
                    </span>
                  </div>
                );
              })}
            </Card>

            <nav aria-label="Everything, by kind" className="mt-auto pt-4 flex items-center gap-x-6 gap-y-2 flex-wrap border-t border-line">
              <span className="text-[12.5px] text-ink-3">Everything, by kind</span>
              <Kind href="#/context/people" label="People" n={num(c.counts.people)} />
              <Kind href="#/context/memories" label="Memories" n={num(c.counts.memories)} />
              <Kind href="#/context/artifacts" label="Artifacts" n={num(c.counts.artifacts)} />
              <Kind href="#/context/journal" label="Journal" n={`${num(c.counts.journalWeek)} this week`} />
              <Kind href="#/skills" label="Skills" n={num(c.counts.skills)} />
            </nav>
          </div>

          <div className="flex flex-col gap-3 min-h-0">
            <Card>
              <CardHead left="Changed this week" right={c.changed.length || undefined} />
              {c.changed.length === 0 && <p className="rw text-ink-2">Nothing changed this week. New and replaced memories show up here.</p>}
              {c.changed.map((x, i) => (
                <div key={i} className="rw items-start">
                  <Dot color={x.tone === "bad" ? "var(--bad)" : "var(--ink-2)"} className="mt-[7px]" />
                  <div><p>{x.text}</p><p className="text-[12.5px] text-ink-3 mt-0.5">{x.detail}</p></div>
                </div>
              ))}
            </Card>
            <Card>
              <CardHead left="Running out" right={c.runningOut.length || undefined} />
              {c.runningOut.length === 0 && <p className="rw text-ink-2">Nothing is running out. Memories with a “good until” date show up here before they lapse.</p>}
              {c.runningOut.map((x, i) => (
                <div key={i} className="rw items-start">
                  <span className="font-mono text-[12px] text-ink-3 w-[46px] pt-[2px] flex-none">{shortDate(x.date)}</span>
                  <span>{x.text} <span className="text-ink-3">· {areaName(x.area)}</span></span>
                </div>
              ))}
            </Card>
          </div>
        </div>
      )}
    </Main>
  );
}

function Kind({ href: to, label, n }: { href: string; label: string; n: string }) {
  return (
    <a href={to} className="inline-flex items-baseline gap-2 text-[13.5px] text-ink-2 hover:text-ink">
      {label}<b className="font-mono font-medium text-[12px] text-ink-3">{n}</b>
    </a>
  );
}
