// Public links: SQLite only, never the vault (it mirrors to GitHub). One row per artifact; a revoked row is replaced by
// the next share, so turning a link off and on again always makes a new, unguessable slug.
import { randomBytes } from "node:crypto";
import { db, one, run, all } from "../db.js";
import { now } from "../config.js";
import { ARTIFACTS_HOST } from "./shared.js";

db.exec("CREATE TABLE IF NOT EXISTS artifact_shares (artifact_id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER)");

export const privateUrl = (id: string) => `https://${ARTIFACTS_HOST}/a/${id}`;
export const publicUrlOf = (slug: string) => `https://${ARTIFACTS_HOST}/s/${slug}`;
export const liveSlug = (id: string) => one<{ slug: string }>("SELECT slug FROM artifact_shares WHERE artifact_id=? AND revoked_at IS NULL", id)?.slug ?? null;
export const publicUrl = (id: string) => { const s = liveSlug(id); return s ? publicUrlOf(s) : null; };
export const liveShares = () => all<{ artifact_id: string; slug: string }>("SELECT artifact_id, slug FROM artifact_shares WHERE revoked_at IS NULL");

// 128 random bits as base64url: 22 characters.
export function newShare(id: string) {
  const slug = randomBytes(16).toString("base64url");
  run("INSERT INTO artifact_shares(artifact_id,slug,created_at,revoked_at) VALUES(?,?,?,NULL) ON CONFLICT(artifact_id) DO UPDATE SET slug=excluded.slug, created_at=excluded.created_at, revoked_at=NULL", id, slug, now());
  return slug;
}
export const revokeShare = (id: string) => Number(run("UPDATE artifact_shares SET revoked_at=? WHERE artifact_id=? AND revoked_at IS NULL", now(), id).changes) > 0;
