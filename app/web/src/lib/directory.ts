import { useEffect, useState } from "react";
import type { Agent, Area } from "../../../shared/types";
import { api } from "./api";
import { hueColor, titleCase } from "./labels";

// Agent and area names are looked up on most screens; fetch each once per session and share the promise.
let agentsP: Promise<Agent[]> | null = null;
let areasP: Promise<Area[]> | null = null;

export function invalidateAgents(): void { agentsP = null; bump(); }
export function invalidateAreas(): void { areasP = null; bump(); }

const listeners = new Set<() => void>();
function bump() { for (const l of listeners) l(); }

function useShared<T>(get: () => Promise<T>, fallback: T): T {
  const [v, setV] = useState<T>(fallback);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const l = () => setTick((t) => t + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  useEffect(() => {
    let live = true;
    get().then((d) => { if (live) setV(d); }, () => {});
    return () => { live = false; };
  }, [tick]);
  return v;
}

export function useAgentList(): Agent[] {
  return useShared(() => (agentsP ??= api.agents().catch((e) => { agentsP = null; throw e; })), [] as Agent[]);
}

export function useAreaList(): Area[] {
  return useShared(() => (areasP ??= api.context().then((c) => c.areas).catch((e) => { areasP = null; throw e; })), [] as Area[]);
}

export interface Who { name: string; color: string }

/** Resolves an agent id (or "you" / "engram") to a display name and dot colour. */
export function useWho(): (id: string | null | undefined) => Who {
  const agents = useAgentList();
  return (id) => {
    if (!id || id === "you") return { name: "You", color: "var(--ink)" };
    if (id === "engram") return { name: "Engram", color: "var(--ink-3)" };
    const a = agents.find((x) => x.id === id);
    return a ? { name: a.name, color: hueColor(a.hue) } : { name: id, color: "var(--ink-3)" };
  };
}

export function useAreaName(): (slug: string | null | undefined) => string {
  const areas = useAreaList();
  return (slug) => {
    if (!slug) return "";
    return areas.find((a) => a.slug === slug)?.name ?? titleCase(slug);
  };
}
