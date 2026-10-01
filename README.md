# Engram

One self-hosted app that knows how I operate and what I know, and is the single door every agent I use goes
through for context, skills and tools. Personal use only.

- Spec: Obsidian `Projects/Engram/Engram - Spec.md`. Build plan: `docs/build.md`.
- Runs on the host at https://engram.example.com, deployed by `deploy/engram.timer` pulling `main`.
- MCP endpoint: `https://engram.example.com/mcp` with a per-agent bearer token made in the Agents screen.

```sh
cd app && npm ci && npm run build && ENGRAM_ROOT=../.data PORT=8340 npm start
```
