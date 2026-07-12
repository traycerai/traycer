# AGENTS.md

This file is the local agent guide for `clients/gui-app`. Read it
together with the repo-root `AGENTS.md`.

## Workspace Purpose

`gui-app` is the standalone Traycer application shell. It is separate from the
older `clients/gui/` webview work and should be treated as a normal
browser-run React application unless the user explicitly asks for native or
desktop-specific integration.

## Stack

- Vite
- React
- TypeScript
- TanStack Router with file-based routing
- TanStack Query
- Zustand
- Tailwind CSS v4
- shadcn/ui primitives
- Vitest + Testing Library

## Important Commands

Run these from `clients/gui-app/`:

```bash
bun run dev
bun run build
bun run test
bun run lint
bun run compile
bun run react-doctor
```

Run `bun run react-doctor` manually after touching gui-app `.ts`/`.tsx` files
and address any findings before committing. It is not wired into pre-commit. For
changed-files-only output against the base branch use
`npx -y react-doctor@latest . --verbose --diff <base> --offline --no-score`.

## Folder Structure

- `src/` Main application source.

- `src/routes/` File-based route modules and route composition.

- `src/components/` App-specific components and layout composition.

- `src/components/ui/` Primitive UI building blocks installed and managed
  through shadcn workflows. Prefer composing these before modifying them.

- `src/providers/` Global providers such as theming and app-wide context setup.

- `src/stores/` Zustand stores for local client state.

- `src/lib/` Shared app-local utilities and infrastructure helpers.

- `src/hooks/` Reusable app-local hooks.

- `public/` Static public assets.

- `__tests__/` Workspace-level tests and smoke checks.

- `dist/` Build output. Treat as generated.

- `.tanstack/` Tool-managed router metadata/cache. Treat as generated.

## Working Rules

- Prefer route and composition changes before editing primitives.
- If the user asks to use primitives directly, keep changes in app composition
  and avoid rewriting `src/components/ui/` unless necessary.
- Use `src/components/ui/agent-spinning-dots.tsx` (`AgentSpinningDots`) for
  loading spinners and animated loading dots. Do not add new ad hoc spinner
  components or inline spinner markup when this component can represent the
  loading state.
- Keep the app browser-safe unless the task explicitly introduces a native host.
- Prefer viewport-agnostic responsive sizing for UI surfaces and layouts. Use
  fluid constraints such as flex/grid sizing, `w-full`, `max-w-*`, `min-h-*`,
  `max-h-*`, percentages, `clamp()`, and viewport units before reaching for
  fixed pixel widths or heights. Only use hardcoded pixel sizing when the size
  is inherently fixed, such as icons, hairlines, or explicit touch targets. Is
  it a good pattern that we have implemented and protected against?- Avoid
  nullish-coalescing fallbacks in JSX `key` props when `undefined` already
  expresses the same remount behavior.
- Preserve TanStack Router file-based routing.
- Use Zustand for local UI/client state, not server-state caching.
- Use TanStack Query for fetched data once data fetching is introduced.
- Always concatenate className values through `cn(...)` from `@/lib/utils`. Do
  not build class strings with template literals, `+`, or `${}` interpolation,
  and do not assemble arrays and `.join(" ")` them. `cn` is the single source of
  truth for conditional classes, conflict resolution via `tailwind-merge`, and
  de-duplication - bypassing it produces stale variants that override the
  intended Tailwind state. Static single-string literals that need no
  composition may remain as plain strings.

## Backend Actions And TanStack Query

Every request/response backend call (host RPC, AuthService, RunnerHost) must
flow through TanStack Query. No `useState<boolean>` loading flags around awaited
backend calls, no ad-hoc try/catch + `toast.error` orchestration in components.

- Host RPC: use `useHostQuery` / `useHostMutation` for single calls and
  `useHostQueries` for arrays. The wrappers own the host-scoped query key
  and the `hostId === null` enabled gate. Do not roll your own
  `queryOptions(...)` + `useQueries(...)` pair against `client.request(...)`.
- Non-host (`AuthService`, `IRunnerHost`): use bare `useMutation` / `useQuery`
  with a stable `mutationKey` from `src/lib/query-keys/`. Do not inline the key
  shape at the call site.
- Hooks return raw `UseMutationResult` / `UseQueryResult`. Do not narrow the
  surface - callers want `isPending`, `error`, `mutate`, `mutateAsync`, `reset`,
  `data`, `variables`. Hook layout:
  `src/hooks/<namespace>/use-<verb>-<noun>-mutation.ts` (or `-query.ts`);
  namespaces: `epic`, `workspace`, `agent`, `auth`, `runner`. Hook name pattern:
  `use<Namespace><Verb><Noun>` - e.g. `useEpicCreate`,
  `useRunnerCliLogin`, `useRunnerRequestHostRespawn`.
- Cache: `invalidateQueries` in `onSuccess` is the default. Optimistic
  `setQueryData` is reserved for response-equals-state cases and must be
  justified explicitly; new mutations should not introduce optimistic writes
  without prior discussion.
- Host-swap race protection: capture the active host id in `onMutate` and
  consume it from the mutation context in `onSuccess`/`onError` so a host swap
  mid-flight does not invalidate the wrong scope.
- Error mapping: each source has one helper in `src/lib/`:
  `toastFromHostError`, `toastFromAuthError`, `toastFromRunnerError`. Mutation
  hooks call the matching helper from `onError`. The exception is surfaces that
  must stay inline-only: the hook omits `onError` and the component renders
  `mutation.error?.message` directly.
- Pending UX recipe: `disabled={mutation.isPending}` + keep the button label
  unchanged + render `AgentSpinningDots` inline next to the label. Do not swap
  labels (no "Submitting…", no "Retrying…").
- Mutation key builders live under
  `src/lib/query-keys/<namespace>-mutation-keys.ts` and are re-exported through
  `src/lib/query-keys/index.ts`. Add new builders there; never inline
  `["mutation", "..."]` literals in hooks or components.

## Remembered Patterns

- Prefer configured import aliases over long relative imports whenever an alias
  exists. In this workspace, use `@/*` for app code and workspace aliases like
  `@core/*`, `@traycer-clients/shared/*`, and `@traycer/protocol/*` instead of
  manual `../../..` paths.

- Structured perf telemetry (separate from the human log) goes through
  `src/lib/perf/perf-telemetry.ts` `logPerfEvent(name, fields)`. It prints a
  `[traycer-perf]` console line the desktop shell appends to a dedicated
  machine-parseable file, `<Electron userData>/traycer-perf.ndjson` (rotates to
  `.ndjson.1` at ~5 MB), instead of `traycer-desktop.log`. Enable with
  `localStorage["traycer:perf:telemetry"] = "1"` (on by default in dev, off in
  tests, opt-in in prod). Sibling gated probes: `main-thread-block-probe.ts`
  (`traycer:perf:mainthread`) and `terminal-load-perf.ts`
  (`traycer:perf:terminal`).

- Keep query-key management centralized. Define durable query-key builders in a
  dedicated `src/lib/query-keys/` area and expose them through a barrel export,
  rather than rebuilding key shapes ad hoc in components, hooks, or tests.

- Keep query fetching concerns separate from query-key definitions. Query keys
  describe cache identity; query helpers can live next to the integration they
  support, but they should consume the centralized key builders instead of
  inventing parallel key layouts.

- For host-scoped TanStack Query data, keep the key hierarchy semantic and
  prefix-based so broad invalidation stays predictable: base host scope →
  host id scope → method/resource scope → params or filters. Invalidating a
  host scope should naturally drop all queries tied to that host.

- Prefer TanStack Router route lifecycle APIs for route concerns: `beforeLoad`
  for auth/redirect guards and route-context setup, `validateSearch` for
  canonical URL/search normalization, and route `loader` + Query prefetch for
  critical server-state hydration. Do not use component effects for work that
  belongs to routing.

- Do not mutate UI/client state from route preloading paths. With Router intent
  preloading enabled, `beforeLoad` and `loader` may run before navigation is
  committed, so tab creation, local store writes, and similar UI mutations must
  stay in committed component lifecycle or explicit user actions.

- Apply the React “You Might Not Need an Effect” bar consistently: use effects
  only for true external synchronization (router ↔ external store, live stream ↔
  UI store, browser API subscriptions). Derived values, cache identities, and
  route control flow should be expressed without effects whenever possible.

## Preferred Local Skills

This repo includes GUI-relevant local skills under `.agents/skills/`. Prefer
using them when the task matches their scope:

- `shadcn` Use for shadcn init/apply flows, preset codes, component lookup,
  registry usage, and primitive composition questions.

- `tailwind-v4-shadcn` Use for Tailwind v4 + shadcn setup, theme token wiring,
  CSS variable issues, dark mode behavior, and Tailwind v4 migration/debugging.

- `tanstack-router-best-practices` Use for route structure, loaders, search
  params, navigation, code splitting, and TanStack Router organization.

- `tanstack-query-best-practices` Use for fetched data, cache keys,
  invalidation, mutations, hydration, and general TanStack Query behavior.

- `tanstack-integration-best-practices` Use when Router and Query need to work
  together, especially loaders, preloading, SSR/hydration, and cache
  coordination.

- `zustand-5` Use for client-side state stores, selectors, persist middleware,
  slices, and Zustand 5 usage patterns.

If multiple skills apply, use the smallest relevant set rather than loading all
of them by default.

## Generated And Tool-Managed Files

These may change automatically and should not be treated as stable design
documentation:

- `src/routeTree.gen.ts` Generated by TanStack Router tooling.

- `components.json` Managed by shadcn init/add workflows.

- `dist/` Build output.

- `.tanstack/` Tool-managed artifacts.

- `.eslintcache` Lint cache output.

When applying a shadcn preset, expect tool-managed updates to:

- `components.json`
- app-level CSS entrypoints
- files under `src/components/ui/`

After any preset or scaffold operation, re-run build and tests.

## Per-Epic State + Y.Doc Projector

Per-Epic state, the editor binding (`Y.XmlFragment`), comment anchors, snapshot
ingest / replica swap / dirty tracking, and the live-Y escape hatch
(`getArtifactFragment`) live under `src/stores/epics/open-epic/`. This area
carries render-count invariants — read the existing code and tests there before
adding fields, actions, or selectors.

## Navigation Advice

- Start in `src/routes/` for page and route work.
- Start in `src/components/` for app-specific UI composition.
- Start in `src/components/ui/` only when the change is truly primitive-level.
- Start in `src/providers/` for theme/provider behavior.
- Start in `src/stores/` for Zustand-driven UI state.
- Start in `src/lib/commands/` for command palette behavior. Sources, dispatch,
  subpages, and the scope/prefix/pin machinery live here. Palette-visible user
  actions must delegate to a function in `src/lib/commands/actions/` (both
  palette sources and manual UI call the same function so behavior stays in
  lockstep).
- Start in `src/components/command-palette/` for the dialog shell, chips, pin
  toggle, and sub-page rendering.

## Testing Philosophy

- Prefer end-to-end tests that run as much of the real machinery as possible
  (real filesystem, real watchers, real docs/stores) over isolated unit tests.
  Most bugs live in the seams between layers, and an end-to-end test also fails
  when an underlying unit is wrong — its capture group is strictly larger.
- Fake only true external boundaries (network, cloud services) or sources of
  nondeterminism.
- Unit tests are acceptable for isolated logic, but treat them as a supplement,
  never as the reason to skip exercising the integrated path.

## Testing Notes

- Tests use Testing Library role queries, so semantic markup and accessible
  names matter.
- If state leaks between tests, reset store state in test setup instead of
  weakening assertions.

## Terminal Theming

xterm.js terminals (`TerminalXtermHost`, used by both `TerminalTile` and
`TerminalAgentTile`) follow the active theme preset + light/dark variant. The
architecture is intentionally small - three TS files plus one CSS file - so
adding a new preset only needs a CSS block.

- **CSS tokens.** Per-preset ANSI palettes live in
  `src/styles/terminal-themes.css` as named custom properties:
  `--term-ansi-{black|red|green|yellow|blue|magenta|cyan|white}` and the
  matching `--term-ansi-bright-*`. `:root` and `.dark` carry the neutral
  defaults that the "neutral" preset and the six accent-only presets share;
  `[data-theme="X"]` and `.dark[data-theme="X"]` blocks override every slot for
  full-palette presets (dracula, github, gruvbox, …). When a theme publishes
  only 8 colors, leave the bright slots unset and the build helper L-shifts
  normals at runtime. Adding a new full-palette preset is one new CSS block; no
  TS changes.

- **DOM cascade owner.** `src/lib/theme-applier.ts` is the imperative owner of
  `<html>` `class` / `data-theme` / `color-scheme`. It subscribes directly to
  the Zustand settings store and the `matchMedia` listener at module load -
  outside React. On any theme/preset change, the applier mutates the DOM
  **before** React re-renders. This is non-negotiable for xterm: the host
  captures its palette as a JS object via `getComputedStyle` inside a `useMemo`
  during render. If `applyVariant` lived in `ThemeProvider`'s `useEffect`, child
  effects would fire before the parent's commit - pushing the previous-toggle's
  palette into `term.options.theme` while the surrounding Tailwind UI flipped to
  the new cascade. (Tailwind doesn't show this race because utilities resolve
  `var(...)` at paint time against the live cascade, with no JS snapshot.) Don't
  write `<html>` class/data-theme attributes from anywhere else.

- **Resolved theme context.** `src/providers/theme-provider.tsx` exposes
  `useResolvedTheme(): { resolvedTheme, themePreset }` via context. The resolved
  value is mirrored from the applier through
  `useSyncExternalStore(subscribeResolvedTheme, getResolvedTheme)`, so by the
  time the context updates downstream, the DOM cascade is already flipped. Read
  context for the resolved value; never read the store directly for it.

- **Build helper.** `src/lib/terminal-theme.ts` -
  `buildTerminalTheme(resolvedTheme, doc)` reads `--term-ansi-*` and the
  semantic tokens (`--foreground`, `--background`, `--primary`) via
  `getComputedStyle`, parses them with culori (the same dependency
  `mermaid-theme.ts` uses), and returns a fully populated xterm `ITheme`.
  `selectionBackground` is `--primary` at α 0.3; `selectionForeground` is
  intentionally undefined so selected glyphs keep their original ANSI color
  (standard terminal behavior). `useTerminalTheme()` wraps the builder in a
  `useMemo` keyed on `[resolvedTheme, themePreset]`. The build is synchronous so
  `new Terminal({ theme })` paints the right palette on the first frame - no
  flash of default xterm colors.

- **L-shift brightening.** When a `--term-ansi-bright-*` slot is unset, the
  builder takes the matching normal, parses to oklch, shifts L by `+0.08` in
  dark mode and `−0.08` in light mode, and reformats to `rgb(...)`. The
  directional flip matches Solarized Light / GitHub Light / Gruvbox Light
  convention (brights are darker / more saturated on a light backdrop, lighter
  on a dark one).

- **Atlas scheduler.** `src/lib/terminal-theme-scheduler.ts` exports
  `scheduleAtlasClear(terminal, webglAddon | null)`. Theme- and font-change
  effects in `terminal-tile-xterm.tsx` enqueue here; one `requestAnimationFrame`
  flushes every pending entry, deduplicated per Terminal instance. Toggling a
  preset with N tiles open fires one rAF burst, not N. Disposed addons (the
  WebGL fallback path) are tolerated.

- **Lazy-loaded host.** `TerminalXtermHost` exports a default symbol so
  `TerminalTile` and `TerminalAgentTile` lazy-load the chunk via
  `lazy(() => import("./terminal-tile-xterm"))` and wrap usage in
  `<Suspense fallback={<TerminalLoadingSkeleton />}>`. The ~150 KB of `@xterm/*`
  is deferred until first terminal mount per session.

- **Font.** `fontSize` and `fontFamily` are the effective terminal values from
  the settings store: `terminalFontSize ?? codeFontSize` and
  `terminalFontFamily ?? codeFontFamily` prepended to the shared default mono
  stack (`src/lib/default-font-stacks.ts`). The font-family string is built
  from store values rather than read from `--traycer-font-mono`, because xterm
  can't resolve CSS variables in its canvas measurement pass and a
  `getComputedStyle` read would race the `ThemeProvider` effect that writes
  the variable's inline override. Live size or family changes trigger a
  `fitAddon.fit()` refit alongside the atlas clear.

- **What stays pinned.** No per-tab terminal palette overrides - every terminal
  mirrors the app theme. The xterm.js stylesheet (`@xterm/xterm/css/xterm.css`)
  is left untouched; scrollbar / search overlay use xterm defaults. Scrollback
  size and `allowProposedApi` are constants in `terminal-tile-xterm.tsx`. Cursor
  shape and cursor blink are Settings → Appearance values
  (`terminalCursorStyle` / `terminalCursorBlink`): captured in
  `initialOptionsRef` for the first paint and live-synced through
  `useTerminalAppearanceSync` (no refit/atlas clear - they don't change cell
  geometry).
