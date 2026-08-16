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
- **Never fill with `bg-muted` on a raised surface.** Every preset theme's
  dark variant defines `--muted` identical to `--popover` and `--card`, and
  the flat light presets (github, gruvbox, tokyo-night, nord, everforest)
  collapse it into `--background` too — so a muted fill inside a dialog,
  popover, dropdown, or card is _invisible_, and only the default light/dark
  pair makes it look right. `--accent` never collapses but is too weak to
  substitute (1.05–1.15 in preset darks). Use an alpha of the foreground,
  which is surface-independent by construction: `bg-foreground/8` for a
  solid fill or an interaction state, `/10` for a skeleton, `/6 · /5 · /3`
  descending for tints. `bg-muted` stays fine for zones on `bg-background` /
  `bg-canvas`, and `bg-muted-foreground` (a text color) is unaffected.
  The rule is about the RENDERED fill, not the utility class, so it binds in
  raw CSS too: `var(--muted)` in a `@keyframes` frame or behind a custom
  property collapses identically and no class-level sweep can see it. Watch
  terminal frames especially — an `animation: … both` frame is not a hand-off
  back to the class, it is the element's permanent background from then on.
  `src/__tests__/muted-fill-on-raised-surface-lint.test.ts` guards the `.tsx`
  half and takes a per-line `// muted-fill-ok: <reason>` waiver for a fill a
  collapse cannot erase — the surface does not collapse (`bg-canvas`), or an
  explicit border or a second state channel survives it.
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

Persisted "last used" and pending state is per-host too:
`composer-run-settings-store`, `composer-harness-memory-store`,
`workspace-folders-store`, and `worktree-intent-memory-store` bucket by
`hostId` (the toolbar store carries it in `catalog.hostId`; a `null` host
drops the write), and every `WorktreeStagingKey` carries the host its slot
stages for. A new read/write of any of these must pass the composer's target
host — never the flat pre-bucket shape.

Anything keyed by a bare **local path** belongs in this set: the same string
names a different directory on two machines, so an unbucketed map silently
merges them. Do not reason that a key is "already host-bound" because its id
happens to imply one host (a chat id, an owner id) — that holds only until
someone adds a slot keyed by an epic or a draft, and nothing checks it. The
migrated memory stores keep their pre-bucket data as a read-only `legacy*`
fallback consulted per key, so a single-host install keeps its memory. That
tier is **transitional**: the first host to act (write or sweep) adopts it
wholesale into its own bucket and retires it, because an unattributed tier
that several hosts read is the same leak in miniature — and one that never
terminates, since a host that supersedes a legacy choice and later has that
entry purged would fall back to the superseded one. Staging slots are pending
picks, so their v1 data is dropped rather than carried.

A host-scoped store also needs its **invalidations** scoped. A worktree sweep
is one machine's filesystem event, so `purgeRemovedWorktreeIntents` (both
stores) takes the swept `hostId` and touches only that host's slots — an
identically-named path or branch on another host still materializes there.
Contrast `clearEpicIntent`, which is account-wide: the epic is gone
everywhere.

`worktreeStagingKeyString` puts the host segment first and percent-encodes it,
so a `:` in a host id can never split the key; an empty segment is the
unresolved-host bucket. Anything that parses a serialized key (the
persistability filter, the purge) counts segments from that layout — add a
segment and both must move with it.

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
