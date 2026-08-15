# AGENTS.md — clients/gui-app

GUI renderer for Traycer. Read with repo-root `AGENTS.md`. Treat as a normal
browser React app unless the task needs native/desktop integration.

**Stack:** Vite, React, TS, TanStack Router (file-based) + Query, Zustand,
Tailwind v4, shadcn/ui, Vitest + Testing Library.

## Commands

```bash
# from clients/gui-app/
bun run dev
bun run build
bun run test
bun run lint
bun run compile
bun run react-doctor   # manual after .ts/.tsx changes; not in pre-commit
```

Changed-files-only: `npx -y react-doctor@latest . --verbose --diff <base> --offline --no-score`.

**Commits:** don't manually run `compile` / `build` / `lint` / `format` before
committing — repo-root `pre-commit` already runs the affected checks (see root
`AGENTS.md`). Tests are CI, not the hook. Re-run checks only when diagnosing
failures. `react-doctor` stays manual (not hooked).

## Map

| Path                          | Role                                                                   |
| ----------------------------- | ---------------------------------------------------------------------- |
| `src/routes/`                 | File-based routes                                                      |
| `src/components/`             | App UI; `components/ui/` = shadcn primitives (compose, don't rewrite)  |
| `src/stores/`                 | Zustand (UI/client state only)                                         |
| `src/hooks/`                  | App hooks (`hooks/<ns>/use-<verb>-<noun>-{mutation,query}.ts`)         |
| `src/lib/query-keys/`         | Central query/mutation key builders                                    |
| `src/lib/commands/`           | Command palette sources + `actions/` (palette and UI call the same fn) |
| `src/stores/epics/open-epic/` | Per-epic Y.Doc projector — read code/tests before changing             |
| `src/providers/`              | App-wide providers                                                     |

Generated — don't hand-edit: `src/routeTree.gen.ts`, `dist/`, `.tanstack/`.

## Non-negotiable rules

- **`cn(...)`** from `@/lib/utils` for all composed `className`s. No template
  literals / `+` / `.join(" ")`. Static single strings OK.
- **Fluid layout sizing** — `w-full`, `max-w-*`, viewport caps. No fixed px/rem
  for layout surfaces (icons / touch targets OK).
- Prefer composition over editing `src/components/ui/`.
- Spinners: `AgentSpinningDots` only — no new ad-hoc spinners.
- No `key={x ?? fallback}` when `undefined` already remounts correctly.
- Zustand = client UI state; TanStack Query = server/host data.
- Keep browser-safe unless the task adds a native host.

## Backend calls → TanStack Query

Every host RPC / AuthService / RunnerHost request goes through Query. No
`useState` loading flags or ad-hoc `toast.error` in components.

| Kind     | Use                                                                               |
| -------- | --------------------------------------------------------------------------------- |
| Host RPC | `useHostQuery` / `useHostMutation` / `useHostQueries` (owns host key + null gate) |
| Non-host | bare `useQuery` / `useMutation` + key from `src/lib/query-keys/`                  |

- Return full `UseQueryResult` / `UseMutationResult` — don't narrow.
- Hook names: `use<Namespace><Verb><Noun>` (e.g. `useEpicCreate`).
- Default cache update: `invalidateQueries` in `onSuccess`. Optimistic
  `setQueryData` only when justified.
- Host-swap races: capture `hostId` in `onMutate`, use it in
  `onSuccess`/`onError`.
- Errors: `toastFromHostError` / `toastFromAuthError` / `toastFromRunnerError`
  in `onError` (omit only for inline-error surfaces).
- Pending UX: `disabled={isPending}` + unchanged label + inline
  `AgentSpinningDots`. Never swap labels ("Submitting…").
- Never inline `["mutation", "..."]` keys — add builders under
  `src/lib/query-keys/`.

Host scope: tab tiles use `useTabHostId()` / `useTabHostClient()`; app-wide
surfaces use `useReactiveActiveHostId()` / `useHostClient()`. Don't mix.

Composers have a **target host** (tab host, fork dialog's fixed host, the
new-conversation modal's host). `null` means "follow the app-wide default":
that is the landing page, whose picker rebinds that default, and the
new-conversation modal opened from the app-wide sidebar trigger, which sits
outside every `TabHostProvider`. Every host RPC around a
composer — mentions, slash commands, harness/model catalog, providers/profiles,
pack retry, catalog refresh — and every surface that dispatches into the
focused composer (the palette's Pick provider/model, via
`FocusedComposerEntry.hostClient`) resolves through that host's client
(`…ForClient` hooks / `runTargetHostId` → `useHostClientForHostId`). The
default-host wrappers (`useDefaultHostClient()`, `useProvidersList()`,
`useGuiHarness*Query()`) are for app-wide surfaces only (prefetcher, Settings,
a palette with no focused composer) — never inside a composer surface.

**Deliberate exception — dictation.** `useDictationAvailability` /
`useVoiceDictation` stay on the app-wide host (`useHostClient()`) even inside a
host-pinned composer. They describe the person at the keyboard, not the run:
`speech.dictate` streams live microphone audio and `speech.ensureModel`
downloads an on-device model, so following a remote run target would ship a
user's audio to a machine they only picked to execute a turn on, and drop a
model download there. The cost is real and accepted — a composer pinned to
host B gates its mic on the app-wide host's model, not B's. Scope a NEW
composer RPC to the target host unless it is about the human's input devices.

## Routing

- Auth/redirects → route `beforeLoad`; search → `validateSearch`; critical
  data → route `loader` + Query prefetch. Not component effects.
- Don't mutate UI/stores from preload paths (`beforeLoad`/`loader` may run
  before commit).
- Effects only for external sync (router↔store, streams, browser APIs).

## Testing

Prefer integrated tests (real stores/docs/watchers) over isolated units. Fake
only external/nondeterministic boundaries. Reset stores between tests; use
Testing Library role queries.

## Skills (use when matched)

| Skill                             | When                           |
| --------------------------------- | ------------------------------ |
| `shadcn`                          | Init/add/primitives            |
| `tailwind-v4-shadcn`              | Theme tokens, dark mode, TW v4 |
| `react-best-practices`            | React / `.tsx`                 |
| `frontend-design`                 | New UI / visual work           |
| `vite` / `vitest` / `zod` / `bun` | As named                       |

Materialized from `skills-lock.json` under `.agents/` / `.claude/`.

## Terminal theming (xterm)

Invariants only — read `src/lib/theme-applier.ts`, `terminal-theme.ts`,
`styles/terminal-themes.css` before changing:

- `theme-applier.ts` owns `<html>` class / `data-theme` (module-load, outside
  React). Don't write those attributes elsewhere.
- ANSI tokens in CSS (`--term-ansi-*`); new full-palette preset = one CSS block.
- `buildTerminalTheme` is sync (no flash); unset bright slots L-shift at runtime.
- Lazy-load `TerminalXtermHost`; clear atlas via `scheduleAtlasClear`.
