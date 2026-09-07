# AGENTS.md - clients/gui-app

GUI renderer for Traycer.
Read with repo-root `AGENTS.md`.
Treat as a normal browser React app unless the task needs native / desktop integration.

**Stack:** Vite, React, TS, TanStack Router (file-based) + Query, Zustand, Tailwind v4, shadcn/ui, Vitest + Testing Library.

## Tooling

`react-doctor` is manual after `.ts` / `.tsx` changes (not in pre-commit).
Changed-files-only: `npx -y react-doctor@latest . --verbose --diff <base> --offline --no-score`.
`pre-commit` already runs affected compile / lint / format.
Do not re-run those before committing.
Tests are CI, not the hook.
Commands live in `package.json`.

Do not hand-edit generated files: `src/routeTree.gen.ts`, `dist/`, `.tanstack/`.

## Non-negotiable

- **`cn(...)`** from `@/lib/utils` for all composed `className`s.
  No template literals / `+` / `.join(" ")`.
  Static single strings OK.
- **Fluid layout** - `w-full`, `max-w-*`, viewport caps.
  No fixed px/rem for layout surfaces (icons / touch targets OK).
- **Safe area** - never write `env(safe-area-inset-*)`; `index.css` owns the only CSS reads.
  `#root` reserves the top and both horizontal insets app-wide.
  Surfaces own the bottom (`pb-safe-bottom`) and anything `fixed`.
  Window-filling: `h-safe-dvh` / `min-h-safe-svh` / `w-safe-dvw`, never raw `h-dvh` / `min-h-svh` / `w-screen`.
  The one sanctioned full-bleed surface is `StandaloneShell` (`data-full-bleed-surface`).
  New tokens must be registered in `cn()`'s `extendTailwindMerge` (`lib/utils.ts`).
  JS geometry (Radix `collisionPadding`): `readSafeAreaInsets()` from `lib/safe-area-insets.ts` only.
- Prefer composition over editing `src/components/ui/`.
- Spinners: `AgentSpinningDots` only.
- **Never fill with `bg-muted` on a raised surface.**
  Preset darks collapse `--muted` into `--popover` / `--card`.
  Use `bg-foreground/8` (fill), `/10` (skeleton), `/6 · /5 · /3` (tints).
  The rule is the RENDERED fill, including `var(--muted)` in CSS / `@keyframes`.
  `src/__tests__/muted-fill-on-raised-surface-lint.test.ts` guards the `.tsx` half (`// muted-fill-ok: <reason>` waiver).
- No `key={x ?? fallback}` when `undefined` already remounts correctly.
- Zustand = client UI state; TanStack Query = server / host data.
- Keep browser-safe unless the task adds a native host.
- **Local browser tiles are CSS-anchored `<webview>` guests.**
  Overlay primitives paint in ordinary DOM stacking above the guest.
  Importing a Radix portal primitive directly outside `src/components/ui/` is banned by the `overlayPortal` ESLint block.

## Host addressing

Read `src/hooks/host/AGENTS.md` when changing host addressing, pins, composer placement, host-scoped stores, or which client a composer RPC uses.

## Backend calls → TanStack Query

Every host RPC / AuthService / RunnerHost request goes through Query.
No `useState` loading flags or ad-hoc `toast.error` in components.

| Kind     | Use                                                                               |
| -------- | --------------------------------------------------------------------------------- |
| Host RPC | `useHostQuery` / `useHostMutation` / `useHostQueries` (owns host key + null gate) |
| Non-host | bare `useQuery` / `useMutation` + key from `src/lib/query-keys/`                  |

- Return full `UseQueryResult` / `UseMutationResult` - do not narrow.
- Hook names: `use<Namespace><Verb><Noun>` (e.g. `useEpicCreate`).
- Default cache update: `invalidateQueries` in `onSuccess`.
  Optimistic `setQueryData` only when justified.
- Host-swap races: capture `hostId` in `onMutate`, use it in `onSuccess` / `onError`.
- Errors: `toastFromHostError` / `toastFromAuthError` / `toastFromRunnerError` in `onError` (omit only for inline-error surfaces).
- Pending UX: `disabled={isPending}` + unchanged label + inline `AgentSpinningDots`.
  Never swap labels ("Submitting…").
- Never inline `["mutation", "..."]` keys - add builders under `src/lib/query-keys/`.

## Opening seams (links + tiles)

Both enforced by `eslint/traycer-tile-open-boundary-rules.mjs`:

- **URL egress** - `useOpenLink()(url, kind, event)` (`lib/links/open-link.ts`).
- **Tile open** - `useEpicTileNavigation().openTile(intent)` (or `openTileWithNavigation` outside a component).

## Routing

- Auth / redirects → route `beforeLoad`; search → `validateSearch`; critical data → route `loader` + Query prefetch.
  Not component effects.
- Do not mutate UI / stores from preload paths (`beforeLoad` / `loader` may run before commit).
- Effects only for external sync (router↔store, streams, browser APIs).

## Testing

Prefer integrated tests (real stores / docs / watchers) over isolated units.
Fake only external / nondeterministic boundaries.
Reset stores between tests; use Testing Library role queries.

## Terminal theming (xterm)

Read `src/lib/theme-applier.ts`, `terminal-theme.ts`, `styles/terminal-themes.css` before changing.

- `theme-applier.ts` owns `<html>` class / `data-theme` (module-load, outside React).
- ANSI tokens in CSS (`--term-ansi-*`); new full-palette preset = one CSS block.
- `buildTerminalTheme` is sync (no flash).
- Lazy-load `TerminalXtermHost`; clear atlas via `scheduleAtlasClear`.

## Mobile detection: build vs viewport

Pick by asking **"should the web app opened in a phone browser get this too?"**

| Signal                                         | Use            | When                                                                              |
| ---------------------------------------------- | -------------- | --------------------------------------------------------------------------------- |
| `useIsMobileViewport()` / `isMobileViewport()` | yes → viewport | Layout and touch-appropriate interaction. Flips live with window width.           |
| `isMobileApp()` (`@/lib/mobile-app`)           | no → build     | Installed-app product policy only. Set once by the Capacitor entry; never layout. |

Capability questions ("can this shell do X?") use `IRunnerHost` capability fields.
