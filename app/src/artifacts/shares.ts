// One link per artifact: https://<artifacts host>/<slug>, with access as a setting (only you, or anyone with the link).
// The slug is 128 random bits kept in SQLite only (never the vault, which mirrors to GitHub), so the URL works as a
// secret. Reset link mints a new slug and the old one never comes back.
import { randomBytes } from "node:crypto";
import { db, one, run, all } from "../db.js";
import { now } from "../config.js";
import { ARTIFACTS_HOST } from "./shared.js";

db.exec(`CREATE TABLE IF NOT EXISTS artifact_links (artifact_id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, public INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, public_at INTEGER)`);
// Before one link per artifact, a public link was a separate slug (artifact_shares). A live one becomes the artifact's
// link, so anything already shared keeps working; revoked ones stay dead. Runs once: later boots find every row there.
if (one("SELECT 1 FROM sqlite_master WHERE name='artifact_shares'"))
  run("INSERT OR IGNORE INTO artifact_links(artifact_id,slug,public,created_at,public_at) SELECT artifact_id, slug, 1, created_at, created_at FROM artifact_shares WHERE revoked_at IS NULL");

export type Link = { artifact_id: string; slug: string; public: number };
const newSlug = () => randomBytes(16).toString("base64url");
export const linkUrl = (slug: string) => `https://${ARTIFACTS_HOST}/${slug}`;

/** The artifact's link, made on first use (artifacts from before links get theirs here or in writeManifest). */
export function linkOf(id: string): Link {
  const r = one<Link>("SELECT artifact_id, slug, public FROM artifact_links WHERE artifact_id=?", id);
  if (r) return r;
  const slug = newSlug();
  run("INSERT INTO artifact_links(artifact_id,slug,public,created_at) VALUES(?,?,0,?)", id, slug, now());
  return { artifact_id: id, slug, public: 0 };
}
export const urlOf = (id: string) => linkUrl(linkOf(id).slug);
export const publicUrl = (id: string) => { const l = linkOf(id); return l.public ? linkUrl(l.slug) : null; };
export const allLinks = () => all<Link>("SELECT artifact_id, slug, public FROM artifact_links");

/** true when it changed. The URL stays the same either way. */
export const setPublic = (id: string, on: boolean) => { linkOf(id); return Number(run("UPDATE artifact_links SET public=?, public_at=? WHERE artifact_id=? AND public=?", on ? 1 : 0, on ? now() : null, id, on ? 0 : 1).changes) > 0; };
export function resetLink(id: string) {
  linkOf(id);
  const slug = newSlug();
  run("UPDATE artifact_links SET slug=?, created_at=? WHERE artifact_id=?", slug, now(), id);
  return linkUrl(slug);
}
/** A forgotten artifact: its link goes for good. */
export const dropLink = (id: string) => Number(run("DELETE FROM artifact_links WHERE artifact_id=?", id).changes) > 0;
