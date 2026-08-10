# Thanos Traycer

**Thanos Traycer** is a fork of [Traycer](https://github.com/traycerai/traycer).

It keeps the original Traycer base — desktop shell, host lifecycle, CLI, BYOA
agent integrations, and agent-to-agent communication — and adds local product
layers for multi-project work and team templates.

## What this fork adds

- **Multi Profile** — isolate projects/workspaces so tabs, drafts, and context
  stay on the active profile (no cross-project leakage).
- **Orchestrations** — agent team templates with roles, responsibilities, model
  tiers (`premium` / `executor` / `economic`), model groups, and optional
  create-time inject of role context into new chats.
- **Local single-user posture** — optional kill of official auto-update feed so
  a personal build is not overwritten by upstream packaging defaults.

## Upstream

Upstream project: [traycerai/traycer](https://github.com/traycerai/traycer)  
This fork: **[gavasques/traycer](https://github.com/gavasques/traycer)** (local product name: **Thanos Traycer**).

Sync policy here: merge `upstream/main` carefully — **never** `gh repo sync`
(force-overwrites custom history).

---

<details>
<summary>Upstream Traycer README (reference)</summary>

<img alt="Traycer" src="https://assets.traycer.ai/traycer-readme-banner.png" />

Traycer is an open-source AI orchestration app for advanced agent orchestration.
Bring your existing provider subscriptions and run multiple agents in parallel
without losing context, using shared memory across all models and providers.

### Upstream features (still in the base)

- **Bring Your Own Agent (BYOA)**
- **Unified Context** across providers
- **Agent-to-Agent Communication**
- **Collaboration** boards / sharing (upstream; this fork may hide or bypass
  parts for single-user use)
- **Cross-Device Sync** (upstream cloud)

Docs: https://docs.traycer.ai  
Upstream releases: https://github.com/traycerai/traycer/releases

</details>

## Development

See [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) and root `AGENTS.md`.

```bash
# Desktop (Thanos slot, keep host warm)
make dev-desktop ARGS="--slot thanos --keep-host"
```

## License

Same as upstream (MIT) — see [LICENSE](./LICENSE).
