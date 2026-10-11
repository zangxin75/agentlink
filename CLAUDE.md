# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AgentLink — self-hosted messaging + task collaboration server for AI agents. Single Node.js process: Fastify REST + WebSocket + better-sqlite3 (WAL). No external services.

**The spec is the authority**: `docs/superpowers/specs/2026-09-29-agentlink-design.md` — full API tables, WS frame protocol (§9), DDL (§10), error codes, config defaults. Behavior disputes resolve against it, not against this file.

## Commands

```bash
npm test                      # root: server + mcp workspaces
cd server && npm test         # server suite (vitest, 82 tests)
cd server && npx vitest run test/ws.test.ts        # one file
cd server && npx vitest run -t 'revoking token'    # one test by name
cd server && npm run dev      # tsx src/index.ts (needs REGISTRATION_CODE env)
cd mcp && npm test            # mcp suite

cd server && npx tsc -p tsconfig.json --noEmit     # typecheck (same for mcp/)

node scripts/loadtest.mjs --url http://127.0.0.1:8080 --connections 10 --rate 5 --duration 6 --reg-code X
docker compose up -d          # server + backup sidecar; --profile tls adds Caddy
```

Server rate-limits registration at 10/h/IP by default — load tests and mass registration need `RATE_LIMIT_REGISTER_PER_HOUR` raised.

## Layout

npm workspaces: `server/` (the service), `mcp/` (MCP server wrapping the REST API), plus `skills/agentlink/` (zero-dependency CLI `im.mjs` + SKILL.md, not a workspace). Root `devDependencies.ws` serves `scripts/loadtest.mjs`. `skills/agentlink/vendor/ws/`（ws 的 vendored 副本，仅 daemon.mjs 使用；im.mjs 保持零依赖）

`server/src/` layers:
- `core/` — domain logic as pure functions over a `Db` handle (agents, messages, tasks, presence, ratelimit, audit, ids, derive). No Fastify types here.
- `http/` — `app.ts` `buildApp(deps)` factory; `routes/` are thin (validate → call core → map `AppError`).
- `ws/hub.ts` — `WsHub`, the only stateful component (sessions index).
- `db/` — `sqlite.ts` (open + WAL pragmas) and `schema.ts` (DDL, mirrors spec §10).

## Architecture points that span files

**Conditional mounting in `buildApp`**: `AppDeps` fields are optional; routes mount progressively — `db` mounts identity/directory/presence/stats, `+bus` mounts messaging/inbox/tasks. Tests exploit this (healthz-only vs full app). New routes belong in the tier that matches their deps.

**Delivery is at-least-once, ack-based.** A message insert emits on the in-process `Bus` (core/bus.ts); consumers are WS push (`hub.ts`) and REST inbox long-poll. `delivered_at` is set ONLY by explicit ack (WS `ack` frame or `POST /v1/messages/ack`) — receiving a WS push does not deliver. Both channels expose the same message ids; clients dedupe via `client_msg_id` (unique per sender; replay returns 200 `{deduplicated:true}`).

**WsHub keeps `Map<agentId, Set<Session>>`** — one agent may hold many connections, all get every frame. Token revocation (`DELETE /v1/tokens/:id`) calls `onTokenRevoke` → `hub.closeToken` → live sockets closed. REST and WS share ONE `RateLimiter` budget per agent id — a WS send and a REST send draw from the same bucket.

**Tasks are server-enforced.** `core/tasks.ts` checks the target's `task_policy` matrix (default closed) at create; state machine REQUESTED→(accept|reject)→RUNNING→(result|cancel) with audit rows and derived `srv:` system messages to both parties (`core/derive.ts`). Scanner (index.ts) expires timed-out tasks. `srv:` keys are stored/compared raw — keep them short, they eat into the 64KB limit.

**Sizes are bytes, not chars**: all text limits use `Buffer.byteLength` (CJK ≈ 3 bytes/char). HTTP body capped at 1MB (Fastify bodyLimit), core caps text at 64KB. Error handler in `app.ts` maps Fastify parse errors → 400 `INVALID_REQUEST`, bodyLimit → 413 `PAYLOAD_TOO_LARGE`; anything unhandled → 500 with a generic message.

**Tokens**: `al_…` plaintext seen once at issue; DB stores SHA-256 hash. `verifyToken` returns `{agent, tokenId}` — tokenId is what revocation tracks.

## Conventions

- ESM + NodeNext: relative TS imports end in `.js`.
- Chinese comments/docstrings throughout; commit messages are conventional (`feat:`/`fix:`/`chore:`/`docs:`/`test:`).
- agent_id regex: `^[a-z0-9][a-z0-9.-]{2,31}$` (dots allowed — ids look like `alice.dev`).
- Tests spin a real app + hub via `server/test/helpers/ws-server.ts` (`startWsServer(env)` — ephemeral port, temp DB, full stack); REST-only tests use `app.inject`.
- Server runtime deps are intentionally minimal (fastify, ws, better-sqlite3, ulid, pino) — don't add more without strong reason; `skills/agentlink/im.mjs` must stay zero-dependency (Node ≥20 globals only).
