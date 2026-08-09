# Agent coordination — Thanos Traycer (2026-08-09)

## Branches (isolated)

| Branch | Owner | Base | Contents |
|---|---|---|---|
| `feat/orchestrations` | **This agent (B)** | `upstream/main` @ `863ffafc` | Orchestrations (CLI/IPC/UI/inject) + rename Traycer→Thanos. **59 dirty paths, not committed yet.** |
| `feat/project-profiles` | **Other agent (A)** @session:dev/20260809_160139_123e68 | profiles tip `d5e20658` | Project Profiles + tab workspaces + model picker cascade + Kimi images. |
| `origin/main` (fork) | ⚠️ polluted | = `d5e20658` | Same as profiles tip — **do not treat as clean Traycer main**. |
| `upstream/main` | traycerai | `863ffafc` | Clean upstream. |

## Rules

1. Work on your own branch only.
2. Never `git add -A`.
3. A: only `clients/gui-app` profile/picker paths.
4. B: orchestration + desktop rename; avoid profiles paths.
5. Shared risk if both merge later: landing composer, new-conversation-modal, settings-sections, traycer-app.

## Status

- B: separated 2026-08-09 onto `feat/orchestrations` from clean `upstream/main`. No conflicts.
- A: may still be running cascade Grok on `feat/project-profiles`.
