# CLAUDE.md

## Fork Setup (gavasques/traycer)

Este repo é um **fork** de `traycerai/traycer` (MIT License), mantido por Guilherme
Vasques para customizações próprias.

**Remotes:**
- `origin` → `https://github.com/gavasques/thanos-traycer.git` (fork — push aqui)
- `upstream` → `https://github.com/traycerai/traycer.git` (original — só pull)

**Caminho local:** `~/Documents/Workspaces/Thanos Traycer`

**Workflow (NUNCA commite em `main` diretamente):**

```bash
# 1. Criar feature
git checkout -b feat/minha-feature
git push -u origin feat/minha-feature

# 2. Puxar updates do original
git checkout main
git fetch upstream
git merge upstream/main
git push origin main

# 3. Rebase da feature sobre o main atualizado
git checkout feat/minha-feature
git rebase main

# Atalho: gh repo sync gavasques/thanos-traycer --branch main
```

> Fork de repo público é público. Suas customizações ficam visíveis, mas a
> licença MIT permite uso fechado do código — só mantenha o aviso de licença.

---

## Feature: Orchestrations

**O que é:** Times de agentes como templates — roles, responsibilities e model
packs — com injeção da responsibility do papel UMA VEZ na criação do chat.
Gerenciado via CLI + Settings UI (CRUD completo, wizard de criação, regra de
team lead obrigatório).

**Dados (no usuário, não no repo):**

```
~/.traycer/model-groups/           ← packs de modelos (default, budget, top, fast, free)
~/.traycer/orchestrations/         ← templates de time
  └── <team>/
      ├── orchestration.json       ← roles + artifact chain + rules
      └── roles/*.md               ← responsibility por papel
```

**Templates seed (v3, genéricos, todos com orchestrator ★):** `auto` (master
auto-pilot por complexidade — default do binding), `dev-squad`, `dev-pair`,
`critical`, `basicos`. Templates próprios do usuário (playbooks/infra privados)
ficam SÓ no disco local — o reconciler nunca reescreve templates fora da lista
de seeds. Seeds em
`clients/traycer-cli/src/store/orchestration-defaults.ts` (SEED_VERSION bump
re-cria roles seed, preserva roles do usuário).

**CLI commands:**
- `traycer orchestration list|show|roles|models|responsibility|prelude`
- `traycer orchestration create|delete --name <team>`
- `traycer orchestration role save|delete --name <team> [--data <json>|--role <id>]`
- `traycer orchestration group show|save|delete --name <pack>`
- `traycer orchestration groups` — lista packs

**Arquivos do fork:**
- `clients/traycer-cli/src/store/orchestration-store.ts` — store (filesystem)
- `clients/traycer-cli/src/store/orchestration-defaults.ts` — seeds
- `clients/traycer-cli/src/commands/orchestration.ts` — command builders
- `clients/gui-app/src/components/settings/panels/orchestrations-settings-panel.tsx` — UI
- `clients/gui-app/src/lib/orchestration/` — inject prelude + effective binding
- `clients/thanos-host/` — loopback host package

---

## Referência

O conteúdo completo de arquitetura, comandos e convenções do projeto está em
[`AGENTS.md`](AGENTS.md). Leia-o antes de mexer no código.

**Nested docs:**
- [`clients/gui-app/AGENTS.md`](clients/gui-app/AGENTS.md)
- [`clients/desktop/AGENTS.md`](clients/desktop/AGENTS.md)

## Map

| Path | Package | Role |
|---|---|---|
| `protocol/` | `@traycer/protocol` | Client⇄host wire contract |
| `clients/traycer-cli/` | `@traycer-clients/traycer-cli` | CLI (host install, auth, agents) |
| `clients/shared/` | `@traycer-clients/shared` | Transport / auth / formatting |
| `clients/gui-app/` | `@traycer-clients/gui-app` | GUI renderer |
| `clients/desktop/` | `@traycer-clients/desktop` | Electron shell |
| `clients/thanos-host/` | `@thanos/host` | Loopback host (local /rpc, no JWKS) |

## Commands

```bash
bun install
bun run build
bun run compile                 # never tsc directly
bun run lint && bun run format
make test-affected              # optional targeted run; CI owns the test gate
bunx nx run @traycer-clients/traycer-cli:build   # single package
pre-commit run --all-files      # explicit full-repo static validation

make dev-desktop                # signed host from Releases + HMR desktop
make dev-desktop VERSION=1.2.3  # pin host release

# Packaged dogfood install → /Applications (unsigned + ad-hoc codesign)
make install-local-desktop                    # CLI + app
make install-local-desktop ARGS="--skip-cli"  # GUI-only, faster
```

`make dev-desktop` talks to the **production** cloud — no local backends. Details:
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

`make install-local-desktop` wraps `scripts/install-local-desktop.sh`: stamps
production config, packages, ad-hoc codesigns, installs to `/Applications`, and
syncs `~/.traycer/cli/bin/traycer`. Keep
`~/.traycer/desktop-local-storage-key` stable across rebuilds (encrypted
localStorage).

**Thanos single-user chrome:** `isThanosSingleUserChrome()` in
`clients/gui-app/src/lib/thanos-flags.ts` hides billing/sharing/account
settings. False in unit tests. Login is still required (cloud history).
Plans: `docs/superpowers/plans/2026-08-12-thanos-hide-account-chrome.md`
and `docs/superpowers/plans/2026-08-12-thanos-no-login-offline.md`.

**Commits:** do **not** manually run `compile` / `build` / `lint` / `format`
before committing. `pre-commit` already runs the affected workspace checks
(build, compile, lint, format). Tests run in CI (`test.yml`), not in the hook —
only re-run checks yourself when diagnosing a hook or CI failure. Commits need
DCO (`git commit -s`).

## Non-negotiable

**Protocol** — `@traycer/protocol` uses per-method `{ major, minor }` RPC versions
negotiated at handshake (not npm semver). CLI **inlines** protocol at build time.
See `protocol/README.md`.

**Host identity** (GUI):

1. `hostId` is canonical; "device" is UI copy — no parallel `deviceId` field.
2. Tabs bind a `hostId` for life (`<TabHostProvider>` → `useTabHostId()`). Never
   use `useReactiveActiveHostId()` inside a tab. Cross-host = **clone-not-migrate**.
   Reachability checked at tab-open only.

**Shared code** — transport/auth in `clients/shared/`; wire contract in
`protocol/`. Don't duplicate.

## Type safety (ESLint — do not bypass)

```ts
// BAD                         // GOOD
fn(x?: T)                      fn(x: T | undefined)
fn(x = 1)                      fn(x: number)  // caller passes explicitly
...args: [T?] | []             // no rest-tuple optionals
as any / as unknown / chained  // narrow or define a real type
ReturnType<typeof fn>          // name the concrete type
```

## Skills

Use when the task matches. GUI skills: see `clients/gui-app/AGENTS.md`.

**Resumo rápido (fork):**
- Stack: Bun 1.3.12 workspaces + Nx, branch `main`
- Build: `bun run build` / `bun run compile` (nunca `tsc` direto)
- Test/Lint: `bun run test && bun run lint && bun run format`
- Commits: DCO obrigatório (`git commit -s`)
- Não rode `compile`/`build`/`lint`/`format` antes de commit — o `pre-commit` hook já faz isso
