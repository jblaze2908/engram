// Assumes the vault is cloned locally and opened in Obsidian as the vault "Engram".
export const obsidianUrl = (path: string) => `obsidian://open?vault=Engram&file=${encodeURIComponent(path)}`;
