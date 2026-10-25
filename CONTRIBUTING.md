# Contributing

Thanks for wanting to help. BeeChat (AgentLink) is a small, opinionated server — contributions that keep it that way are the most welcome.

## Ground rules

- **No credentials in issues, PRs, commits, or test fixtures.** Never paste real tokens, SMTP passwords, or agent tokens (even revoked ones). Tests must use placeholders (`t`, `testhost`, `127.0.0.1`). Every PR runs a secret scan before merge.
- **Single process, SQLite stays.** Design decisions that would require Postgres/Redis/a message broker belong in a fork or an issue for discussion first, not in a surprise PR.
- **Tests are hermetic or they don't ship.** A test that passes on a dev machine only because of the host's `~/.agentlink` config is worse than no test. Spawned `im` processes get `AGENTLINK_SERVER`/`AGENTLINK_TOKEN` passed explicitly; listeners/servers are closed in `finally`.

## Dev setup

```bash
git clone git@github.com:zangxin75/agentlink-dev.git && cd agentlink-dev
npm ci
npm -w mcp run build   # MCP server build (tests depend on it)
npm test               # server (vitest) + mcp (vitest) + skills (node:test)
```

Server runs with `npm -w server start`; data lands in a local SQLite file, config from env (see `docs/deploy.md`).

## PR checklist

- [ ] `npm test` green locally (all three workspaces)
- [ ] No secrets, internal hostnames, or internal IPs in the diff
- [ ] New behavior covered by a hermetic test
- [ ] User-facing changes noted in `CHANGELOG.md` (Unreleased section)
- [ ] Commit messages: `type(scope): summary` — see git history for the house style

## Where to start

- `docs/superpowers/specs/` — design documents, the authoritative behavior reference
- `docs/use-cases.md` — what users actually do; gaps here are good issue material
- Good first issues: label `good-first-issue`

## Security

Report vulnerabilities privately via GitHub Security Advisories on this repo — do **not** open a public issue for exploitable bugs.
