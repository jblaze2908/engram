import { api } from "../lib/api";
import { useAgentList, useAreaName, useWho } from "../lib/directory";
import { shortDate } from "../lib/format";
import { href } from "../lib/router";
import { useLoad } from "../lib/useLoad";
import { obsidianUrl } from "../lib/obsidian";
import { BackLink, Card, CardHead, Dot, Empty, ErrorNote, H1, Lede, Lines, LinkBtn, ListPane, Loading, Main, Split } from "../components/ui";

export function Skills({ name }: { name?: string }) {
  const load = useLoad(() => api.skills(), []);
  const areaName = useAreaName();
  const who = useWho();
  const list = load.data ?? [];
  const picked = name ?? list[0]?.name;
  return (
    <Split picked={!!name}
      list={
        <ListPane title="Skills" sub="How-tos your agents load when a task fits.">
          {!load.data && (load.error ? <ErrorNote error={load.error} onRetry={load.reload} /> : <Loading />)}
          {load.data && list.length === 0 && (
            <p className="px-3 text-[13px] text-ink-3 leading-relaxed">No skills yet. Add a folder with a SKILL.md under skills/ in the vault, and give it to agents from the Agents screen.</p>
          )}
          {list.map((s) => (
            <a key={s.name} href={href(["skills", s.name])} className="it" aria-current={s.name === picked ? "true" : undefined}>
              <Dot color={s.pending ? "var(--signal)" : s.agents.length ? "var(--ink-3)" : "var(--warn)"} className="mt-[7px]" />
              <span className="min-w-0">
                <span className="block">{s.name}</span>
                <span className="block text-[12.5px] text-ink-3 mt-0.5 truncate">
                  {s.agents.length === 0 ? `${areaName(s.area)} · not given to any agent`
                    : `${areaName(s.area)} · ${s.agents.map((a) => who(a).name).join(", ")} · used ${s.uses7d}×`}
                </span>
              </span>
            </a>
          ))}
        </ListPane>
      }
      detail={
        <Main>
          {picked ? <SkillDetail name={picked} /> : load.data ? (
            <Empty title="No skills yet.">A skill is a how-to an agent loads when a task fits, like how to file a bill or write in your voice. Engram keeps one copy and sends it to the agents you choose.</Empty>
          ) : null}
        </Main>
      } />
  );
}

function SkillDetail({ name }: { name: string }) {
  const load = useLoad(() => api.skill(name), [name]);
  const areaName = useAreaName();
  const who = useWho();
  const agents = useAgentList();
  if (!load.data) return load.error ? <ErrorNote error={load.error} onRetry={load.reload} /> : <Loading />;
  const s = load.data;
  const without = agents.filter((a) => !a.revoked && !s.agents.includes(a.id));
  const lines = s.body ? s.body.replace(/\n$/, "").split("\n").length : 0;
  return (
    <>
      <BackLink href="#/skills" label="Skills" />
      <p className="text-[13px] text-ink-3 flex items-center gap-3 flex-wrap">
        <span>Skill · {areaName(s.area)} · v{s.version}, updated {shortDate(s.updated_at)}</span>
        <a className="ml-auto hover:text-ink-2" href={obsidianUrl(`skills/${s.name}/SKILL.md`)}>Open in Obsidian</a>
      </p>
      <H1 className="mt-3">{s.name}</H1>
      <Lede>{s.description || "No description yet. Agents decide when to load a skill from its description, so write one."}</Lede>
      {s.pending > 0 && (
        <Card hot className="mt-6 px-5 py-3.5 flex items-center gap-3">
          <Dot color="var(--signal)" />
          <p className="flex-1 text-[13.5px]">{s.pending === 1 ? "An agent proposes a change" : `Agents propose ${s.pending} changes`} to this skill. {s.pending === 1 ? "It waits" : "They wait"} in your inbox.</p>
          <LinkBtn href="#/inbox">Review</LinkBtn>
        </Card>
      )}
      <div className="grid grid-cols-1 wide:grid-cols-[1fr_330px] gap-3 mt-3 flex-1 min-h-0">
        <Card className="overflow-hidden flex flex-col min-h-0">
          <CardHead left="SKILL.md" right={<span className="font-mono text-[11.5px]">{lines} lines</span>} />
          <div className="overflow-y-auto min-h-0">{s.body ? <Lines text={s.body} /> : <Empty>SKILL.md is empty.</Empty>}</div>
        </Card>
        <div className="flex flex-col gap-3">
          <Card>
            <CardHead left="Given to" right={s.agents.length || undefined} />
            {s.agents.length === 0 && <div className="kv"><span>Nobody yet</span><a className="text-data" href="#/agents">Agents</a></div>}
            {s.agents.map((a) => {
              const w = who(a);
              return <div key={a} className="kv"><span className="flex items-center gap-2 text-ink-2"><Dot color={w.color} />{w.name}</span><span /></div>;
            })}
            {without.length > 0 && <div className="kv"><span>{without.map((a) => a.name).join(", ")}</span><span className="text-[12.5px] text-ink-3">not given</span></div>}
          </Card>
          <Card>
            <CardHead left="Used this week" right={`${s.uses7d}×`} />
            <p className="rw text-[13px] text-ink-2">{s.uses7d ? "Counted each time an agent loads it." : "Not loaded this week."}</p>
          </Card>
        </div>
      </div>
    </>
  );
}
