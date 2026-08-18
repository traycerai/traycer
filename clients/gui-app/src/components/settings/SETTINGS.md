# Settings Architecture

## Overview

The settings UI lives in `src/components/settings/` and is mounted by the
TanStack Router `/settings/*` routes.

This surface is a **real local settings shell**:

- the routes, layout, sidebar, and panels are real
- settings values persist locally through Zustand
- every settings row is wired into runtime behavior. The previously-inert
  Language, Speed, Show in menu bar, and Default workspace mode rows (written
  but never read) were removed.

When changing the settings surface, update this file in the same change.

## Structure

```text
SettingsLayout
├── SettingsSidebar
└── Outlet
    └── settings panel route
        ├── GeneralSettingsPanel
        ├── AppearanceSettingsPanel
        ├── ProvidersSettingsPanel
        ├── NotificationsSettingsPanel
        ├── AgentsSettingsPanel
        ├── KeybindingsSettingsPanel
        ├── ShellSettingsPanel
        ├── WorktreesSettingsPanel
        ├── HostSettingsPanel
        ├── AppDiagnosticsSettingsPanel
        ├── DiagnosticsSettingsPanel
        └── UsageSettingsPanel
```

Settings is also presented as a **modal** via `settings-modal-content.tsx`,
which maps each `SettingsSectionId` to its panel in a `switch`. A new section
must be added in BOTH places - the route file under `src/routes/` AND the modal
`switch` - or the modal renders a blank pane for that section.

Six other places enumerate section ids, and four of them fail loudly when one
is missed. `settings-modal-content.tsx`, `stores/tabs/kinds/settings.tsx`
and `report-issue-dialog.tsx`'s `ROUTE_TEMPLATE_LABELS` are exhaustive over a
union or over `FileRouteTypes["fullPaths"]`, so a compile error catches them.
`lib/analytics.ts` is exhaustive only because `ANALYTICS_SETTINGS_SECTIONS` is
built through `satisfies Record<AnalyticsSettingsSection, true>` - that
`satisfies` is doing real work, and without it a missing id silently drops the
navigation event. The two `SETTINGS_PATHS` sets (`stores/tabs/store.ts` and
`stores/tabs/desktop-tabs-persistence.ts`) are hand-written string sets with no
gate at all: a section absent from them stops being recognised as a settings
route for persistence. `devices` was missing from both for its whole life.

## Key Files

- `settings-layout.tsx` Owns the two-column shell for the settings route.
- `settings-sidebar.tsx` Renders navigation from `settings-sections.ts`.
- `settings-panel-shell.tsx` Shared width, header, and panel spacing - density-
  aware (see below).
- `settings-row.tsx` Shared label/description/control row - also density-aware.
  The label owns the flexible width; controls stay pinned to the trailing edge.
  If a wide control wraps, it remains right-aligned on its new line instead of
  falling under the label at the leading edge.
- `settings-group.tsx` A named group of rows: a small, quiet label OUTSIDE a
  bordered card (never a row-shaped band inside one). Used by General; `tone:
"danger"` gives Danger Zone its restrained-red card without a separate
  component.
- `panels/*.tsx` Route-mounted settings sections.
- `controls/settings-select.tsx` Shared select wrapper used by settings rows.
- `src/stores/settings/settings-store.ts` Persisted local settings state.
- `src/providers/settings-density-context.ts` `SettingsDensityContext` /
  `useSettingsDensity()` - `"compact" | "relaxed"`, default `"relaxed"`.
  `settings-modal-content.tsx` provides `"compact"` for the modal overlay
  (`PromotableModalFrame` hard-caps its content at `80vh`); the promoted-tab
  route path never provides it, so it stays `"relaxed"` by default. A discrete
  signal from the two known entry points, not a measured container query -
  the overlay's height ceiling is architectural, not something that varies
  continuously with window size. `SettingsPanelShell` and `SettingsRow` read
  it directly (tighter header/row padding and a smaller title in `compact`);
  General and Worktrees additionally read it locally for their own bespoke
  multi-card gaps. Out of scope: the Worktrees toolbar/list rows, which stay
  unchanged regardless of density.

## Scope: the organising idea

Settings is grouped by WHAT A SETTING BELONGS TO, and the grouping is
load-bearing rather than cosmetic.

- **Application** - General, Appearance, Keybindings, Diagnostics.
- **Account** - Sessions, Usage.
- **Host** - headed by THE host picker (`host-scope/host-switcher.tsx`).
  Everything under it - Overview, Providers, Worktrees, Notifications, Agent
  selection, Shell, Diagnostics - is scoped by that one selection.

**Two sections are both called "Diagnostics"**, one per group, and the group
heading above each is what distinguishes them - the same way the rail already
distinguishes everything else. Their ids do not collide: the host one keeps
`diagnostics` (it is the one in existing bookmarks and remembered tab paths)
and the app one is `app-diagnostics`. The one surface with no group headings is
the command palette's settings sub-page, which is a flat list, so
`navigation.source.ts` gives every section row its group label as a
`statusBadge` rather than badging only the pair that collides - an absence of
badge would otherwise start meaning something, and the next duplicate label
would ship looking unambiguous.

Usage sits in **Account**, not Host (ticket 13). What it reports is the
ACCOUNT's token and cost spend, with the host as one filter INSIDE the page
that defaults to all of them - so it does not vary by host, which is the rule
the groups encode. Under the sidebar's picker it would have put two competing
host scopes on one screen, with the outer one unable to describe the number
the inner one produced. It still reads through a host CLIENT, as every RPC
does; that is a transport fact, not a scope one.

Application and Account lead because they are short, fixed and never re-shaped;
the host group goes last because it is the only one whose contents depend on a
selection.

**Scope is not a level.** Settings already spends its nesting budget inside
Providers, which is a rail plus a per-provider tab bar - so the sidebar gets
exactly one level and the host cannot become another one. Earlier attempts that
made the host a tier (tabs across the content, an accordion of host cards in
the rail) all pushed the deepest page four levels down. The picker is
navigation only.

**One place per host verb.** There is no Hosts page. A separate collection page
looks harmless but is a second lifecycle surface the moment it can change an
update policy, which is exactly what the old "My Hosts" list did - so adding,
comparing and updating hosts all resolve to: the picker lists them, the `+`
footer adds one, and everything else about a host lives on that host's Overview
(`host-scope/host-registry-updates.tsx` holds the registry half of Updates,
beside the local controller's own region in the SAME card).

**The picker inherits the composer's row anatomy**
(`components/home/host-workspace-selector/host-section.tsx`): kind glyph, name,
status dot, check. Two pickers over one concept must not each invent a
vocabulary. Search appears from six hosts up; below that it is one more thing
to skip past.

**Nothing in the host group is local-only any more.** Shell and Diagnostics
carried a `requiresLocalHost` flag (dimmed rail rows, a `RequiresLocalHostNotice`
in place of the page) for one reason: both read the on-disk config store through
the local CLI bridge, so they could only ever describe this computer. That was
always stated as a TRANSPORT limit rather than a scope one - shell config and
`hostLogLevel` are fields of the selected host's own config - and the
`config.*` / `diagnostics.*` RPCs removed the limit rather than the sections.
The flag, the dimming and the notice are all gone; every section under the
picker now reads whichever host the picker names. Overview followed the same
route one batch later, for the same reason and with the same shape: the
lifecycle verbs were bridge-only, `host.restart` / `host.doctor` /
`host.identity.*` / `host.update.*` / `host.getInstallationInfo` removed the
limit, and the bridge was demoted to a recovery console for the one state that
still has no host process to ask.

What replaced it is one predicate, `localConfigFallbackReason(host,
methodsSupported)` (`host-scope-model.ts`), answering "may this page read this
computer's disk instead, and why":

| Host                | Can't be dialled                 | Handshaked without the methods    | Answers fine |
| ------------------- | -------------------------------- | --------------------------------- | ------------ |
| **This computer's** | bridge, `reason: "host-stopped"` | bridge, `reason: "host-outdated"` | RPC          |
| **Remote**          | gate notice (unreachable)        | `HostConfigUnsupportedNotice`     | RPC          |

Three things about that table are load-bearing:

- **The local column falls back for BOTH failures.** RPC-only would take
  log-level raising and host-log tailing away exactly while someone is debugging
  a host that will not start - and would ALSO take shell editing away for the
  whole window in which the app has updated and the host it manages has not. The
  store the bridge reads is the same machine-user-global file the host loads, so
  the fallback describes the host it names; `LocalConfigFallbackNotice` says
  which of the two reasons applies, because one calls for starting the host and
  the other for updating it.
- **The remote column never falls back.** There is no local truth about another
  machine, and substituting this computer's values under its name is the exact
  failure the scope model exists to prevent. An old remote host gets
  `HostConfigUnsupportedNotice`, which self-heals when it updates and
  re-handshakes.
- **`methodsSupported` is the TRI-STATE `useHostMethodSupport`, not the
  boolean.** `null` means no handshake has completed yet, and the panel's own
  first RPC is what produces one - so treating `null` as absent would divert a
  perfectly capable host onto the bridge permanently, before its RPC path was
  ever tried.

This replaced a flat list in which "Appearance" (this app), "Sessions" (your
account) and "Providers" (one specific host) were indistinguishable peers,
and in which FOUR sections had each grown their own host `<Select>`: Providers
(header), Worktrees (toolbar), General -> File Edit Snapshots (a settings row,
directly above a destructive button) and Agent selection (floating above the
editor). They differed in width, placement and scoping mechanism while doing
one job.

All four are gone, and nothing replaced them: a panel states NOTHING about which
host it is scoped to. An interim pass put an inert `HostScopeLine` readout where
each dropdown had been, on the theory that content owes the reader the host name
at the point of use. It does not - the sidebar picker already carries the name,
the health dot and the "Viewing -" note, and the readout was that same fact
printed a second time in four places, which is the duplication this surface
exists to remove. So panels carry only the controls they own.

One caveat, stated because an earlier draft of this file got it wrong: the
picker is NOT permanently on screen. The rail is a single `overflow-y-auto`
`<aside>`, so at a short viewport the host group can scroll out of view like
anything else in it. The argument for removing the readout is
non-duplication, not permanent visibility. `settings-host-select.tsx` and `use-settings-host-scope.ts`
are deleted; `useHostScope` is the only host scope in Settings.
`settings-host-labels.ts` survives solely for the composer's
`host-workspace-selector`.

**Two host relationships, kept apart by grammar.** Merging them is the defect
the whole surface guards against:

- **Viewing** (`stores/settings/settings-host-scope-store.ts`) - which host
  Settings is administering. Free, reversible, no effect outside Settings.
  Renders as neutral chrome; never accent-coloured.
- **Active for this window** (`HostDirectoryService.selectById`, read through
  `useAddressableHostId`) - which host this window talks to for ambient
  work: notification indicators, the bell, rate limits, the resource monitor,
  and where newly started work lands. Changed ONLY by a labelled verb that
  states its consequence ("Use in this window", in the Overview card's action
  bar, with the tabs-stay-put asymmetry on its tooltip), never as a dropdown
  side effect. Always wears the accent - on the Overview that is the `Active`
  tag beside the host name, which replaced a full-width row asserting the same
  boolean.

`useHostScope()` (`host-scope/use-host-scope.ts`) is the single hook every
host-scoped panel reads. Its status enum is the safety contract, because three
of its states look identical if you only check `client !== null`:

| Status        | `client` | The panel must                                                                                          |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `following`   | ambient  | render normally - the ambient client IS the scoped host's                                               |
| `connecting`  | `null`   | render its loading shape, NEVER the ambient client's data                                               |
| `unreachable` | `null`   | say so - terminal, not pending; never a spinner that cannot resolve                                     |
| `vanished`    | `null`   | say the host was deregistered and offer a way back - it must NOT silently re-resolve to the active host |
| `ready`       | scoped   | render normally                                                                                         |

The invariant every consumer owes: **a visible host name must always match the
client used by every read, stream and mutation beneath it.** Because the only
visible host name is the sidebar's, that reduces to one rule: a panel must
neither render content NOR issue a host read while the scope has no client
behind it.

Two mechanisms, and the split matters:

- `HostScopeGate` (`host-scope/host-scope-gate.tsx`) decides what is
  **rendered**, and it also stops its children ACTING. It guards its CHILDREN
  and nothing else - a control passed as a sibling prop (`headerAction`) is
  outside it, which is how Providers' Refresh button once re-probed the ambient
  host while the page named another. Inside, a non-usable scope holds the
  subtree in a hidden `<Activity>`: React tears its effects and subscriptions
  down, so a query hook under a dead scope genuinely cannot fire. Panels
  wrapped by the gate (Shell, Diagnostics, Providers' scoped content) therefore
  do NOT need a second `isHostScopeUsable` guard on the reads they own - and
  adding one is the cargo-cult this note exists to prevent.
- `isHostScopeUsable(status)` decides what is **mounted**, and is for host
  reads that live OUTSIDE the gate's children. Those still fire and cache their
  answer whatever the gate renders, so a panel that keeps such a read - as
  Diagnostics does for the `cli`/`host` log-level rows, whose hook is held at
  panel level - must ask this before mounting it.

Every section in the `host` group mounts the gate, and both Shell and
Diagnostics wrap their bodies in it whole. Diagnostics used to be the exception,
keeping its app-scoped rows outside the gate because their subject never changed
with the scope; splitting those onto Application -> Diagnostics removed the
exception rather than working around it. Both re-provide `HostRuntimeContext`
for an explicit pick through `useScopedHostBinding` - the same
`status === "ready"` guard Providers uses, so no hook beneath them can resolve
to the ambient host.
Overview does the same (`host-settings-panel.tsx`), and it mixes the two gate
styles on purpose because its regions sit on three different capability planes:

- the **whole-panel gate** covers only "the scope resolved to nothing" and
  `vanished`. The reason is the one that motivates the gate at all: a `null`
  scoped host that defaulted to "local" once put this computer's service
  console under a host that no longer exists.
- **Installation** is pure host RPC, so it mounts the gate itself and the gate
  says why it is missing. The status card's ACTIONS (Restart / Run doctor / Use
  in this window), the rename pencil, and the host's own update check are
  withheld outright without a route rather than rendered disabled - "disabled"
  would read as a capability verdict when the fact is connectivity.
- the **account-backed** half - update policy, drain-gate force, and Remove
  from account - needs no route and keeps rendering for a host that cannot be
  reached, which is a common moment to want exactly those. The danger zone
  gates its own rows for the same reason. The version PIN used to sit here and
  no longer does: picking a version means picking one the host listed, so it
  moved to the RPC half and an unreachable host can no longer be pinned.

The recovery console is the one surface still on the CLI bridge, and it is NOT
gated on reachability: it exists for a host that is down, so gating it on
dialability removed Install and Start in precisely the state they serve.

**One host model.** The app carries two host lists that need not agree - the
runtime directory (what this client can dial; it alone knows `websocketUrl`)
and the cloud registry (what the account owns; it alone knows presence leases,
platform, update state). Every old picker was built on exactly one of them and
was therefore blind to a real class of host. `buildHostScopeOptions`
(`host-scope/host-scope-model.ts`) is their UNION keyed by `hostId`, recording
`connectable` / `registered` so a row present in only one list renders honestly
instead of being dropped or faked. NOTE: `HostDirectoryEntry.kind` is
`local|remote|mock` while `HostListItem.kind` is `personal|sandbox` - same
field name, disjoint values. The merged model deliberately exposes neither
directly.

**One health vocabulary.** `deriveHostHealth` (`host-scope/host-health.ts`)
replaced two disjoint dialects that described the same machine: the
registry-backed presence words and the local service words ("Running" /
"Stopped" / "Not installed"). It keeps a coarse `state` a person acts on plus a
`detail` fragment carrying the nuance the old design spent a row of pills on.
`stopped` and `not-installed` stay distinct from `offline` because they are the
two a person can act on. It DELEGATES to `deriveHostPresence`
(`panels/my-hosts-model.ts`) rather than re-deriving it.

The precedence across the two is one chain, and each step outranks the next for
a stated reason: **local process read** (a direct read of the service on this
box) -> **live session** (an open E2E connection is firsthand proof) ->
`status.connectivity` (the cloud's relay-attachment answer, and the only one
available for a host this client has never dialled).

`connectivity` is the ONE cloud liveness signal. It replaced a heartbeat lease
plus a separate relay-attach bit, and with them the states that existed only to
narrate those two disagreeing ("Reconnecting", "Not reporting"). Its remaining
invariants are tested and load-bearing: no green dot without live evidence;
`unknown` (liveness unreadable) never renders as a false "Offline"; and
`local-only` - a host the account's plan will never expose remotely - is an
upgrade prompt, not an outage.

Two things a reader of this file will look for and not find in the DTO:
`busy` and `busySessionCount`. They describe a _right now_ the cloud's lease
cannot carry, so they come from `host.status@1.1` over a live connection (or
the notification room's `hostRuntimeStatus` awareness field). No live source
means the drain UI renders NOTHING - never a zero, which would offer to end
"0 sessions" on a host that never told us how many it had.

## Sections

- `General` App behavior, agent activity, and local data controls, divided
  into four named groups via `settings-group.tsx`: a small, quiet `<h2>`
  label sits OUTSIDE its own bordered card, so orientation (the label) and
  action (the card's rows) read as different things - a group label never
  looks like another setting row. This replaced an earlier row-shaped
  section-header-band-inside-one-card layout (`settings-section-header.tsx`,
  now deleted) after user feedback that the bands blended into the options
  and ran too tall; a design pass (`general-settings-core-flows` artifact)
  settled the current shape. Groups are ordered by frequency and risk
  (most-touched first, destructive last), not alphabetized; row internals,
  controls, and confirmation flows are unchanged from before either reorg.
  - **Chat & composer**: Voice input (`voice-settings-section.tsx`), Quote
    reply on text selection, Steer with Cmd/Ctrl+Enter (toggles the fixed
    chord's mid-turn-steering semantics - stays out of Keybindings, which is
    for rebinding), Pin context usage breakdown (global toggle for the
    always-visible agent context-window breakdown, default off).
  - **Running agents**: Prevent sleep while running, Show global resources
    button, Show navigator resource stats (these stay out of Appearance -
    they change information visibility, not styling).
  - **Setup & migration**: Product tour (replay onboarding), Data migration
    (retry moving local SQLite tasks/epics to cloud - stays out of
    Diagnostics, which is support capture, not user data recovery).
  - **Danger Zone** (`DangerZoneSection`, `SettingsGroup` with `tone:
"danger"`, `data-testid="settings-danger-zone"`, kept last): **Local app state
    only** (reset tabs/layout/drafts/settings/view prefs + reload) - the one
    destructive action here that is genuinely about this APP rather than about
    a host. File Edit Snapshots and Remove Traycer both moved to
    `host-scope/host-danger-zone.tsx` on the scoped host's own Overview: each
    acts on ONE host's data, and a host-scoped destructive row sitting on an
    app-wide page is how a snapshot wipe could be aimed at a host the page
    never named. Their arm-time target capture lives there too, alongside the
    remote counterpart added with the Overview restructure, **Remove from
    account** - see the Host Overview section for its copy rule. The zone's
    distinct restrained-red card/label tone is unchanged from before the
    reorg, just carried by the shared group component instead of bespoke
    markup.
- `Appearance` Five preference groups via `settings-group.tsx`, broad-to-
  specialized in one column: **Theme**, **Interface**, **Typography**,
  **Terminal**, **Artifact icons** - each a quiet `<h2>` label outside its own
  bordered card; changes apply live, the surrounding app stays the primary
  preview. A design pass (`settings-related-panels-core-flows` artifact,
  extending the compact Settings language past General/Worktrees to five more
  panels - Appearance, Notifications, Diagnostics, Shell, Host) introduced
  this grouping; the controls themselves are unchanged except where noted
  below.
  - **Theme**: Theme mode (`ThemeModeToggle` - Light/Dark/System,
    `theme`/`setTheme`) and Preset (`ThemePresetPicker`,
    `themePreset`/`setThemePreset`) - broad color/surface choices lead.
  - **Interface**: Zoom (`DesktopZoomSettingsRow` - desktop-only, renders
    nothing without a zoom bridge; backed by
    `useRunnerZoomPercentQuery`/`SetMutation`/`ResetMutation` against host/OS
    state, not a settings-store field) and Use pointer cursors
    (`pointerCursors` `Switch`, default on).
  - **Typography.** Two structurally identical rows - `UI font` and
    `Code font` - each pairing a font picker with its size input stacked
    directly below. `Terminal font` moved out to its own **Terminal** group
    below (it pairs with the cursor rows and the live preview, not with UI/Code
    sizing) - the three fonts still share one storage/resolution model, only
    the grouping changed. Backing state lives in `settings-store.ts`:
    `uiFontFamily` / `codeFontFamily` / `terminalFontFamily` (`string | null`)
    and `terminalFontSize` (`number | null`) - `null` means "use the default"
    (UI: Figtree, Code: the system mono stack) or, for the two terminal
    fields, "follow the Code font/size". `uiFontSize` is clamped 10-20 (it
    scales the root font-size and breaks layout above that); `codeFontSize`
    and `terminalFontSize` are clamped 10-24. `theme-provider.tsx` applies
    `uiFontFamily`/`codeFontFamily` as inline overrides of
    `--traycer-font-ui`/`--traycer-font-mono` (chosen font + the default
    stack as fallback), removing the override when `null`. The effective
    TERMINAL font (`terminalFontFamily ?? codeFontFamily`,
    `terminalFontSize ?? codeFontSize`) is resolved once by
    `useEffectiveTerminalFont` (`hooks/settings/`) and applied inline by its
    three consumers - the xterm host, this panel's `TerminalPreview`, and the
    managed-command output window (`managed-command-output-tile.tsx`, whose
    content is a program's stdout and so is terminal output too). None of
    them can read it from CSS: `--traycer-font-mono` carries the CODE font,
    so `font-mono` would silently ignore a Terminal override, and xterm
    measures glyph cells on a canvas where CSS variables do not resolve at
    all. `terminal-tile-xterm.tsx` additionally live-syncs both values into
    `term.options` (see `useTerminalAppearanceSync`). The
    `@pierre/diffs` diff viewer follows the code font via
    `--diffs-font-family` / `--diffs-font-size` set on `[data-diffs-host]` in
    `diff-tokens-css.ts`.
  - **Font picker (`controls/font-picker.tsx`).** Searchable Popover + cmdk
    combobox (modeled on `theme-preset-picker.tsx`). Its first entry is
    always the group's default label ("Figtree (Default)" / "System Default"
    / "Same as code font") and selecting it stores `null`; typing a name
    absent from the list offers a "Use `<typed>`" item so unlisted/misdetected
    fonts, and non-desktop hosts (no enumerated list at all), still work. Each
    option renders in its own typeface via inline `style={{ fontFamily }}`.
    When the value is `null` the trigger shows the default label muted; a
    ghost reset button (`RotateCcw`) occupies a permanently-reserved `size-7`
    gutter to the _left_ of the trigger and appears once a font is chosen. The
    reserved left gutter means the trigger's right edge stays flush with every
    other control in the panel and never shifts as the reset toggles. All three
    rows offer the full installed-font list - no monospace pre-filter, because
    the OS `monospace` trait misdetects many real mono fonts (e.g. Nerd Font
    builds) and the picker already lets you free-type any name.
  - **UI/Code size input (`controls/settings-number-input.tsx`).** Plain
    non-nullable number field. Takes a `defaultValue`
    (`DEFAULT_UI_FONT_SIZE` / `DEFAULT_CODE_FONT_SIZE`, the same constants the
    store initializes from) and shows a ghost `RotateCcw` reset button in the
    reserved `size-7` left gutter whenever the current size differs from it,
    restoring the default on click - mirroring the font picker's reset gutter
    so the two rows stay aligned.
  - **Terminal size input (`controls/nullable-font-size-input.tsx`).**
    `SettingsNumberInput`-alike but nullable: displays `terminalFontSize ??
codeFontSize` in muted styling while `null`; any tick/type pins an
    explicit value starting from what was displayed; a ghost reset button
    clears back to `null`. Kept as a separate component because its reset target
    is `null` (follow code) rather than a fixed default.
  - **Terminal** (group). `Terminal font` (font picker + the nullable size
    input, one row) plus `Terminal cursor` and `Blink cursor` sit in a
    `@container` split with the live preview: one column of rows on the left,
    `TerminalPreview` on the right (`grid-cols-1 @min-[32rem]:grid-cols-[7fr_5fr]`,
    a divider border between them above that width, stacked below it) - the
    preview is part of the group's card, not a separately labelled row (it
    used to be its own `SettingsRow` with a "Terminal preview" label; that
    label is gone since the group title and layout already say what it is).
    - **Terminal cursor
      (`controls/terminal-cursor-style-picker.tsx` + a `Switch`).**
      `Terminal cursor` is a segmented shape picker (iTerm2
      style - each option draws the actual glyph, block centered) backed by
      `terminalCursorStyle` (`"block" | "bar" | "underline"`, default `block`);
      `Blink cursor` is a `Switch` backed by `terminalCursorBlink` (default on).
      Both are captured in the host's `initialOptionsRef` for first paint and
      live-synced into `term.options` via `useTerminalAppearanceSync`. On blur the
      cursor stops blinking (xterm's inactive cursor never blinks) and
      `cursorInactiveStyle` mirrors the chosen shape via `inactiveCursorStyleFor`,
      except `block` falls back to a hollow `outline` so an unfocused pane stays
      visually distinct. `TerminalPreview` reflects the chosen shape/blink with a
      CSS-only cursor (reads the store directly, no xterm instance) so the effect
      is visible without spawning a real terminal.
  - **Artifact icons** (group). One row, `Artifact icon colors`
    (`EpicNodeIconColorPicker`, `controls/node-icon-color-picker.tsx`) - a "Use
    type colors" `Switch` (`artifactIconColorMode`, `"byType" | "none"`,
    **default `"byType"`** - the palette is visible out of the box, this is an
    opt-out toggle, not an opt-in-from-collapsed one) that reveals a 2-column
    swatch grid (one native color input per `EpicNodeKind`) plus a Reset only
    while enabled. Turning type colors off hides the grid but keeps
    `artifactIconColors` in the store untouched, so turning it back on restores
    the same custom colors instead of resetting them.
  - **Installed-font enumeration.** Desktop-only, following the same chain as
    `systemPreferencesAppearance`: `RunnerHostInvoke.fontsList` IPC channel →
    `listInstalledFonts()` (`electron-main/app/installed-fonts.ts`, backed by
    the `font-list` package's `getFonts2()`, deduped/sorted, empty array on
    enumeration failure) → registered in `platform-ipc.ts` → exposed as
    `platform.fonts.list()` on both `PlatformBridgeSurface` (preload) and
    `DesktopPlatformBridge` (renderer-shell). gui-app reads it through
    feature-detected `getInstalledFontsBridge()`
    (`lib/desktop-installed-fonts.ts`, mirrors `desktop-log-levels.ts`) via
    `useRunnerInstalledFontsQuery` (`staleTime: Infinity`; resolves `[]` on
    shells without the bridge instead of erroring).
- `Providers` Per-provider CLI binary selection (Codex / Claude Code / OpenCode
  / Traycer / Cursor). Left rail picks the provider (brand icons via
  `HarnessIcon`); the
  right pane shows an enable/disable `Switch` and a radio table of CLI
  candidates - the host-bundled binary, the binary auto-detected on PATH
  (shown by its real absolute path), and any custom paths the user added
  (deletable). The radio picks the active binary; "Add custom path" reveals an
  inline input with a live `--version` probe. The rail + config area fills the
  settings scroll container's height (via the shell's `fillHeight`, capped by
  `bodyClassName` max-height) so switching providers never resizes it; the
  config pane - not the outer overlay - owns the scroll, and the height follows
  the viewport so a tall provider config never overflows the modal. The header
  also shows
  host-reported account metadata when the selected provider can expose it (for
  example Codex/Claude email and subscription label). Backed by the host
  `providers.*` RPC (`providers.list` / `providers.setSelection` /
  `providers.addCustomPath` / `providers.removeCustomPath` /
  `providers.setEnabled` / `providers.detectVersion` /
  `providers.setEnvOverride` / `providers.deleteEnvOverride`) through
  `useHostQuery` / `useHostScopedMutation`. The pane carries NO host picker of
  its own: the sidebar switcher scopes it, and the panel re-provides the
  runtime client for its subtree from `useHostScope` (transient
  `useHostClientFor`) only once the scope is `ready`. The list query and the
  Refresh control sit INSIDE `HostScopeGate` rather than in the panel header,
  because the header renders outside the gate and reached the ambient host
  there. Selection + custom paths + enabled flag + per-provider env persist
  host-side in `~/.traycer/host/config/provider-overrides.json` (per-device
  == per-host). Disabling a provider marks it unavailable in the new-agent
  picker. `providers.list` is cached for 15 min
  (no auto-refetch on remount/focus) to avoid re-running `--version` probes; a
  header refresh icon (`RefreshIconButton` → `useRefreshProviders`)
  force-refreshes the list and harness availability on demand.
  - **The detail pane is tabbed, and the tab RAIL is the only thing between the
    provider header and its config.** Order is `account` · `usage` · `general` ·
    `env` · `modelProviders` · `mcp` · `plugins` · `skills`, filtered per provider through
    `supportedTabsFor` (`provider-settings-tabs.ts` - pure, so the rule is
    tested without rendering the panel).
    - **The provider header and the rail are PINNED rows; only the active tab's
      body scrolls.** `ProvidersRailLayout`'s detail column used to carry
      `overflow-y-auto p-5` around the whole of `ProviderDetail`, so the rail
      scrolled away with its content and a seven-tab pane lost its navigation
      as soon as you moved. Scroll ownership now sits on `TabsContent`
      (`min-h-0 overflow-y-auto`), with `min-h-0 flex-1 flex-col` repeated down
      every level between the panel body and it - a flex item defaults to
      `min-height: auto` and refuses to shrink below its content, which pushes
      the overflow straight back up to the column and un-pins the rows above.
      - **Pinned as a SIBLING row, not `position: sticky`.** That is what makes
        it work without a background: nothing ever passes under the rail, so it
        needs no opaque fill - which the pane's translucent `bg-card/40` could
        not have supplied without a visible band.
      - Horizontal padding lives on the column so the rail's `border-b` keeps
        exactly the width it had when the column owned the scroll; the body
        cancels it with `-mx-5 px-5` so its scrollbar lands on the pane edge
        rather than 5 units inside it.
      - `Tabs` runs `gap-0` and the rail-to-body spacing is the body's own
        `pt-4`. With the gap on `Tabs`, the scroll box started below the rail's
        rule and content vanished in mid-air above itself; owned by the body,
        the clip edge and the rule are the same line.
      - Radix mounts only the ACTIVE `TabsContent`, so there is exactly one
        scroll box and switching tabs starts it at the top.
      - Guarded by `expectPinnedRailLayout` in
        `providers-settings-panel.test.tsx` - structurally (the rail and the
        enable switch must NOT be inside the tabpanel, and no ancestor of the
        tabpanel may carry `overflow-y-auto`) plus the one class that carries
        the mechanism, since jsdom has no layout engine and cannot be asked
        whether something scrolls.
    - **Ids are wire enum members; labels are display strings, and only labels
      are ever renamed.** `supportedTabs` rides `nativeCapabilities`, which a
      released client decodes through one
      `.catch(DEFAULT_PROVIDER_NATIVE_CAPABILITIES)` over the WHOLE object - an
      id an older client cannot parse fails the enum and drops that entire
      object, silently taking MCP/Plugins/Skills with it. So `general` displays
      as **"CLI & Args"** and `usage` as **"Profiles & Limits"** while both ids
      stay put. The old "General" named nothing about its contents, which is
      what the rename fixes.
      **`usage`'s label is PER-PROVIDER** (`providerTabLabel`): that tab holds
      managed profiles and usage limits, but managed profiles exist for
      `claude-code` and `codex` only — so on the other ten providers the fixed
      label promised a section that is not there. Elsewhere it reads
      **"Usage limits"**, which is the panel's own words for what remains (the
      section inside is headed exactly that). The ID never varies; this is
      presentation.
      The predicate is a deliberate MIRROR of the host's
      `providerSupportsManagedProfiles`, which is itself an id check — there is
      no capability on the wire to read instead, because the host answers this
      before it builds one. `profiles` cannot stand in for it: for an
      unsupported provider it is empty BY RULE
      (`resolveProfileWireEntries` returns `[]` without consulting the
      registry), and an unseeded `claude-code` is empty too, so a label keyed on
      the count would name the wrong tab and then change under the user. Adding
      a profile-capable provider means updating both sides; the cost of missing
      it is a tab that under-promises for a round.
    - **`account` is CLIENT-ONLY and deliberately not in the wire enum.** It is
      derived from `state.apiKey.supported` alone. The API key and the
      profile/limits surfaces answer different questions ("how does this
      provider authenticate?" vs "which account is running, and how much of it
      is left?"), and a provider can have either without the other - amp takes
      a key but advertises no `usage` tab at all, claude-code has profiles and
      limits but no key field - so one shared tab always showed a hole for
      whichever half a provider lacked. Nothing about "does this take a key?"
      needs the host to say so, and adding an id to the enum would risk the
      whole-object `.catch` above for zero gain.
    - **The visible set is the host's advertisement, PLUS client-derived
      `account`.** There is no per-provider subtraction left. `general` used to
      be dropped for cursor and amp by a `hidesCliCandidates` id check, on the
      premise that an SDK-driven provider has no CLI binary a user could pick.
      Both of them spawn the Traycer-resolved binary for their MCP write verbs
      (`runAmpCliCapture`, `runCursorMcpCli`), so that table was the only
      control over the binary those verbs use - and hiding it turned "no `amp`
      on PATH" into an MCP tab with Add/Delete/auth silently gone and no way to
      supply a path. The emptiness worry it encoded is answered upstream
      instead: the host's `baseBinaryName` is an exhaustive switch, and the
      candidates section renders a real "not found, here's how to install it"
      empty state rather than a bare table. `usage` is taken at the host's word:
      the contract
      registry already gates it on being able to POPULATE it (managed profiles,
      the Traycer subscription card, or rate limits - see
      `providerCanPopulateUsageTab`), so re-deriving that here would just be a
      second copy of the same rule.
    - **`variant="line"` (underline), not the filled default.** Seven unrelated
      panes is navigation; a filled track reads as a segmented control, which
      is for re-presenting one dataset and tops out around four options. The
      list keeps `w-full` for the `border-b` RAIL but the track itself is
      transparent, so the old "filled slab with dead space after the last tab"
      (`w-full` cancelling the primitive's `w-fit` while triggers stayed
      content-width) cannot recur. The nested Tools/Instructions tabs inside
      the MCP tab deliberately stay on the FILLED variant so the two nesting
      levels read as different tiers.
    - **No per-tab content dots.** The former `tabHasContent` dot could not
      tell the truth: `general` lit for every CLI-backed provider including the
      ones whose tab was empty, `usage` lit unconditionally for every
      rate-limit-capable provider, and mcp/plugins/skills were hardcoded to
      never light - so the three tabs that actually hold user-installed content
      were the three that looked empty. It also used `bg-primary` ("needs
      attention") for what was at most "is configured", reusing the same dot
      the provider rail spends on "disabled". A future signal must split those
      meanings: a muted count on the list tabs, a warning tone reserved for
      real attention.
  - **Provider environment variables.** Each provider detail pane (last, below
    the CLI picker and terminal-agent args) has an _Environment variables_ card
    holding the per-provider env applied when the host spawns that harness
    (`getProviderSpawnEnv` layers it over the host-process env). Rows set a
    value, explicitly unset a variable inherited from the user's shell, rename a
    key, or delete the override. New variables are staged behind an _Add
    environment variable_ button and applied only from the row check button.
    Backed by the per-host `providers.*` RPC
    (`providers.setEnvOverride` / `providers.deleteEnvOverride`, with the list
    carried in `providers.list`'s `envOverrides`), persisted host-side in
    `provider-overrides.json` so it follows the host picker. Rendered with the
    shared `EnvOverrideEditor` component (also used by Settings → Shell).
  - **Terminal interface CLI arguments.** A `TerminalAgentArgsSection` text input (saved
    on blur/Enter) captures extra CLI args spliced into the spawned argv when the
    provider is launched as a terminal agent. The field re-syncs to the saved
    value if it changes underneath (refetch / another window) and stays editable
    while a save is in flight (writes are serialized host-side). Shown only for
    terminal-agent-capable providers - it checks `useGuiHarnessesQuery` for the
    mapped harness (`HARNESS_ICON_ID`) advertising the `tui` `mode`, so GUI-only
    providers do not show it. Persisted as `terminalAgentArgs` in
    `provider-overrides.json` via `providers.setTerminalAgentArgs`
    (`useProvidersSetTerminalAgentArgs`, invalidates only `providers.list`). In
    `agent.tui.prepareLaunch` the host tokenizes the string and each harness
    adapter splices it where its CLI parses it as top-level flags (appended for
    Claude/OpenCode, but BEFORE Codex's `resume` subcommand). The launch picker
    pre-fills this value as a cosmetic default; an untouched pre-fill launches
    with `null` so the host resolves the current saved value itself.
  - **API-key providers (Cursor).** Cursor authenticates with an API key rather
    than a CLI login, so it renders an `ApiKeySection` (masked input +
    Save/Clear) when `state.apiKey.supported` — **as the whole body of the
    client-derived `account` ("Account") tab**. It used to sit ABOVE the tab bar
    as its own pre-tab region, which put a provider's only real setting outside
    the tabs that were supposed to hold its settings (and hid the fact that
    Cursor's General tab rendered nothing). Nothing renders between the provider
    header and the tab rail now. Also a "Create an API key" link
    that opens the provider dashboard via `runnerHost.openExternalLink`
    (`API_KEY_DASHBOARD_URL`). The key is stored AES-256-GCM encrypted in
    `provider-overrides.json` and never returned over RPC - `state.apiKey` only
    reports `configured` + `source` (`stored` | `env`). When unset, the host
    falls back to `CURSOR_API_KEY` from the user's login shell. Cursor's account
    line is probed from that API key with `@cursor/sdk`'s
    `Cursor.me({ apiKey })` for the user email. The token and key-identifying
    metadata are never returned over RPC. Traycer does not run
    `cursor-agent about` for provider auth because GUI chats use `@cursor/sdk`,
    not the CLI login session. Backed by `providers.setApiKey` /
    `providers.clearApiKey` (`useProvidersSetApiKey` /
    `useProvidersClearApiKey`). Cursor is GUI-only, so its row hides the CLI
    candidates table and shows only the API-key section; the key drives the
    `@cursor/sdk` GUI chat surface.
  - **Traycer subscription + credits.** The Traycer provider detail leads with a
    `TraycerSubscriptionSection` card (always visible, not gated by the
    enable/disable toggle since it is account- not binary-level) showing the
    signed-in user's plan: tier badge (`subscriptionStatus`), a Trial badge when
    `isInTrial`, and a **Credit breakdown** with `N% used` plus a consumed/total
    bar per bucket - **Plan**, **Bonus**, **Bundle** - matching the VS Code
    extension's wording (`getCreditBreakdown`; "Bundle" is what older copy called
    pay-as-you-go). Each bar is shown only when that bucket's total > 0; amounts
    are `$`-denominated. Credit-based vs rate-limit-based is decided exactly like
    the extension (`isCreditBasedPricing` - V3 plans are credit-based); **legacy /
    v2 (usage-limit) plans** instead render a **Usage limit** section with the
    recharge rate ("New artifact every N minutes", from `rechargeRateSeconds`)
    plus the Bundle bar. The extension's live "Artifact Used" bar is omitted -
    `totalTokens`/`remainingTokens` come from the inference `GetRateLimitUsage`
    gRPC, which the gui-app/daemon stack doesn't expose. Also a "Manage
    subscription" link (opens the platform URL via
    `resolveManageSubscriptionUrl(runnerHost.authnBaseUrl)`, reused from
    `user-menu.tsx`), and a refresh icon. A global account-context selector
    (Personal / each Team, shown only when the user has `teamSubscriptions`)
    chooses which subscription is displayed - the selection persists in the
    `account-context-store` (localStorage), defaulting to Personal when nothing
    is stored or the persisted team is gone. Credits come from `useAuthUser`
    (TanStack Query against `AuthService.fetchAuthenticatedUser` →
    `/api/v3/user`, `refetchOnWindowFocus`); they live only in the query cache,
    never the auth store.
  - **Traycer OpenCode binary selection.** Traycer's built-in harness runs
    through OpenCode, so its row renders the same available OpenCode CLI paths
    and lets users choose the binary for Traycer separately from the standalone
    OpenCode provider. The table shows Traycer's own candidate list, falling
    back to OpenCode's displayed candidates when Traycer's is empty, while
    `providers.setSelection` / `providers.addCustomPath` /
    `providers.removeCustomPath` still target `providerId: "traycer"`.
    Traycer has no API key field. The enable toggle remains a real gate:
    disabling it hides the Traycer harness from the new-agent picker and blocks
    runs like any other provider.
  - **MCP scope is ONE picker that always names its destination**
    (`provider-mcp-scope-picker.tsx`, `McpScopePicker` - a Popover + cmdk list
    reached from `McpScopeHeader`). It replaced a `[Global | Project]` chip
    pair plus a separate folder `<Select>` that appeared only in Project.
    - **Why the split was wrong.** Global named nothing, so "where does this
      server go?" had no on-screen answer while a shadow project read ran
      against a folder the user could not see. Project silently adopted the
      single resolved folder (`hostPaths.length === 1`) and rendered it as
      STATIC TEXT, so the most common case never looked like a choice. And both
      labelled folders by basename only, which cannot distinguish two worktrees
      of one repo.
    - **Rows.** `Global` ("Every workspace on this host") sits above one row
      per target. Targets come from `useMcpScope`: the resolved workspace
      folders, PLUS every worktree the host reports for them
      (`useWorktreeListByWorkspacePathsForClient`), deduped by path since a repo
      open under two folders reports the same worktree set twice. Each row
      carries name + a `worktree` badge + branch + the full path, because the
      branch is what actually separates sibling worktrees. Selecting a row
      picks the folder AND the scope - they were never two decisions.
      `selectedByHostId` (`providers-workspace-selection-store.ts`) is validated
      against every offered target, not just the open workspaces, so a stored
      worktree selection survives a reload.
    - **The trigger is ONE line at `h-7`, matching `Button size="sm"`.** It
      shares a toolbar row with "Add MCP server", and a two-line control beside
      a one-line button reads as a layout mistake rather than as emphasis. The
      second line's content did not disappear: the subtitle (Global's promise,
      or the selected worktree's branch) rides inline as muted text, and the
      full absolute path - the part that disambiguates two worktrees - moved to
      the trigger's tooltip while staying on every row of the open list.
    - **An empty list is a state you can act on, not a dead end.** Targets are
      derived from the folders THIS client has opened
      (`useWorkspaceFoldersStore` → `useResolvedWorkspaceFolders`), which is
      legitimately empty on a fresh install or a host whose work happens
      elsewhere - and then the picker offered Global and nothing else, with no
      way to reach a project config at all. The list now says
      "No workspaces added on this host yet." and carries an **Add a workspace
      folder…** row driving the same `pickAndPrepareFolders` the Home workspace
      selector uses, bound to the SETTINGS-selected client so a folder picked
      while viewing host B is prepared on B. The added folder becomes the
      selection; a cancelled pick changes nothing.
    - **The selection is keyed by the BOUND host, not the active one.**
      `useMcpScope` reads `client.getActiveHostId()` and only subscribes to
      `useAddressableHostId()` for the re-render. Settings can target a
      non-active host through the transient `HostRuntimeContext` override, and
      keying by the active host filed a B-picked path under A - where it could
      never validate against the list it was picked from.
    - **The single-workspace default is kept but no longer invisible** - it
      renders as a selected control that can be changed, rather than a
      sentence. With more than one candidate there is still no auto-pick.
    - A provider advertising only one `list` scope gets a plain "Applies to
      every workspace on this host." line instead of a picker holding one dead
      option; the wording matches the Global row so the two never disagree.
      Plugins and Skills remain hardcoded global-scope and get no picker.
    - The OAuth resume key is `{providerId, scope, workspaceRoot, hostId}`
      (`useResumeOauthPolling`) - any change to how `workspaceRoot` is derived
      has to keep that tuple stable across navigation.
  - **A row shows the provider's OWN artwork or NOTHING**
    (`ProviderEntryIcon`). There is no fallback glyph anywhere:
    - Skill rows never had a source for one - a skill is a markdown directory
      and no provider's format carries artwork for it. They are distinguished
      by their source badge.
    - Plugin rows without artwork show nothing either. An earlier version drew
      a derived monogram (initials over a hashed tone); it asserted a visual
      identity the plugin never declared, and beside real vendor logos it read
      as a rendering fault rather than as "this one has no icon". Only Codex
      ships plugin artwork, so that fallback was the COMMON case, not the rare
      one. `provider-entry-monogram.ts` was deleted outright.

    A hand-written id-to-icon table remains refused - it would be wrong the
    first time anyone installs something unknown, the same reason this repo
    refuses static model catalogs.

    **Alignment is a list-level decision.** `reserveIconSpace` is true when ANY
    row in the list has artwork, and every row then holds the same footprint -
    empty where there is no icon - so the names keep one left edge. A provider
    that ships no plugin icons at all gets no column at all rather than a
    permanently blank one.

  - **Codex plugin metadata comes from `<version>/.codex-plugin/plugin.json`.**
    The host listing used to be synthesized from DIRECTORY NAMES alone (three
    `readdir` calls, no file opened), so rows read `pdf` and
    `pdf@openai-primary-runtime` where Codex's own UI reads "PDF" / "Read,
    create, and verify PDF files". All of it was in that manifest's `interface`
    block, unread. `listCodexPluginsFromHome` now reads it and fills
    `displayName`, `description`, and `hasIcon`. Three traps live here:
    - **The manifest is untrusted** - a plugin is an arbitrary user-installed
      directory, so `interface.composerIcon` may legally be
      `"../../../../etc/passwd.png"`. Asset paths are containment-checked with
      `path.relative` (not a `startsWith` prefix test, which would accept a
      sibling like `/plugins/foobar` under `/plugins/foo`) and restricted to an
      image extension allow-list. No MIME sniffing: the value ends up in a
      `data:` URI handed to `<img>`.
    - **The cache is not an installed-set, and a SYMLINK is the tell.** An
      installed plugin has a real versioned directory (`sites/0.1.33`); a
      merely-staged one has a bare `latest` symlink into the marketplace tree,
      which is what `openai-bundled/chrome/latest` is - and `codex plugin list`
      calls chrome "not installed". Following the symlink looks like an
      obvious improvement and is wrong: it surfaces a plugin the user does not
      have, with a name and artwork read out of staging. Plugins with no real
      version directory are skipped entirely (`isInstalledVersionDir`).
      Cross-checked against the CLI: excluding them yields 12 rows, matching
      the CLI's 9 installed plus the 3 remote-installed `openai-curated-remote`
      plugins it does not account for.
    - **Version choice is load-bearing now.** It used to be
      `versionDirs[versionDirs.length - 1]` - readdir order, under which
      `0.1.9` outranks `0.1.10`. That was cosmetic while only the version
      string came off it; the chosen directory is now also where the manifest
      and the artwork are read from.
  - **Icons travel on their own RPC arm, never on the plugin list.**
    `nativeListQuerySchema` gains a `pluginIcon` arm (modelled on
    `mcpDiscover`, the existing per-item detail query) returning a `data:` URI.
    Three constraints force that shape:
    - **A path or `file://` URL cannot work.** Desktop CSP is
      `img-src 'self' data: blob: https:` - no `file:` - the `app://` handler
      is sealed to the renderer bundle, and a host-local path renders nothing
      against a REMOTE host, which is a shipped paid mode. Bytes over the
      existing websocket behave identically local and remote.
    - **They cannot ride the list.** Icons are ~900 KB (~1.2 MB base64) for a
      typical Codex install - one 1024x1024 PNG is 451 KB - and
      `useProvidersPluginsList` runs `staleTime: 30_000`.
    - **`poll: false` on the icon query is load-bearing.** `providers.list` is
      condition-polled and condition queries join the table-owned poll BY
      DEFAULT; `refetchInterval` also fires regardless of `staleTime`, so the
      hook's `staleTime: Infinity` would not save it. Omitting `poll: false`
      puts every icon on a refetch timer.

    **Theme-aware artwork rides the same arm.** The request carries a `theme`,
    and two rules keep it honest:
    - **The pair must be coherent.** There is no `composerIconDark` in the
      format - only `logoDark`, whose light counterpart is `logo`. So a plugin
      declaring `logoDark` uses the `logo` / `logoDark` pair; everything else
      uses `composerIcon` for both themes, exactly as Codex renders it.
      Pairing `composerIcon` with `logoDark` would swap between two different
      assets on a flip: github declares an 853 B `github-small.svg` against a
      9.4 KB `github-dark.png`.
    - **`hasDarkIcon` gates whether the request varies by theme at all.** Only
      3 of 13 plugins ship a dark asset. The renderer pins the rest to
      `light`, so their query key is theme-independent; without that, a theme
      flip would miss the cache on every row and re-fetch the whole ~900 KB
      set to receive byte-identical images. A `dark` request for a plugin with
      no dark asset still answers with the light one rather than "no icon".

    The list's `hasIcon` flag is what keeps rows without artwork from each
    burning a round trip, so it is resolved host-side at LIST time (including
    a `stat`, so a declared-but-absent file reports `false` rather than
    promising an icon the fetch cannot deliver). The icon request addresses a
    plugin BY ID and the host re-walks to resolve the file - the renderer never
    hands the host a filesystem path, the same discipline as
    `assertRemovableSkill`. `readPluginIcon` is optional on
    `ProviderNativeBehavior`: only Codex's plugin format carries artwork, and a
    required method would mean seventeen stubs asserting nothing. Absent, or
    resolving to a null `dataUri`, both mean "render no tile".

  - **`enabled` comes from `codex plugin list --json`, with a known gap.**
    Enabled/disabled is Codex state, not a filesystem fact, so the directory
    walk could only hardcode `true`. The CLI read is injected
    (`CodexPluginEnabledLookup`) rather than called directly - the real binary
    is installed on a typical dev machine, so an un-injected test would
    exercise the live CLI locally and an empty result in CI, passing for two
    different reasons. It is enrichment, never a gate: the call is
    `.catch`-guarded at the CALL SITE (not merely inside the default lookup, or
    the invariant would hold by accident), on a 5 s budget versus the 60 s
    install budget, so a missing or slow CLI degrades to the default instead of
    emptying the tab.

    THE GAP: the id namespaces do not fully align. Ours is
    `<name>@<cache-dir>`, the CLI's is `<name>@<marketplace>`. They coincide for
    `openai-primary-runtime`, `openai-bundled` and `pr-completion`, but the
    cache directory `openai-curated-remote` has no CLI counterpart - the CLI
    lists those under `openai-curated` and calls them "not installed" even
    though they are installed through the remote-install path. So github /
    slack / openai-templates miss the map and keep `enabled: true`. They must
    NOT be matched by name alone: `github@openai-curated` is a catalog entry
    whose `enabled` says nothing about the installed copy.

  - **A skill row opens its full `SKILL.md`**
    (`ProviderSkillDetailDialog`). The row can only ever show frontmatter
    (name + description) - the instructions the agent actually follows live in
    the file body, which was unreadable from the app. The dialog mirrors the
    plan card's expand (`plan-segment.tsx`): the same three-row shape and a
    scrollable `TraycerMarkdown` body, so both "show me the whole document"
    surfaces behave alike.
    - Content is read on open via `workspace.readFile`, passing `skill.path`
      as the containment root and `SKILL.md` as the file, rather than carried
      on the list response: adding a body field would put every skill's full
      text on every `providers.skills.list`, paid on each poll, for something
      read only when opened.
    - **HOST DEPENDENCY:** that resolver treats `workspacePath` as the
      containment root and does NOT require it to be a bound workspace, which is
      the only reason a skill directory under `~/.agents/skills` can be read at
      all. Hardening it to accept known roots only would break this surface;
      `SKILL.md` would then need its own read verb.
    - `stripSkillFrontmatter` removes the leading `---` block before rendering
      (the header already shows those two fields, and a renderer with no
      frontmatter plugin prints them as a `<hr>`-delimited paragraph). It is
      deliberately narrow - only a block at byte 0 with a closing fence - so a
      body that legitimately opens with a horizontal rule keeps its first
      section.
    - The dialog is mounted only while a skill is open, so the Skills tab does
      not hold a disabled host query (and its QueryClient dependency) on every
      render.
    - **Remove lives in the dialog footer, behind TWO conditions**
      (`skillRemovability`). `actionScopes.remove` advertising a scope says the
      provider supports the verb; `skill.source` says whether this skill's files
      are ours to delete. The host's `assertRemovableSkill` accepts only
      `shared` / `provider` sources (and re-checks realpath containment in a
      writable root) and throws otherwise, so a `plugin` or `managed` skill
      under a remove-capable provider satisfies the first and fails the second.
      The client mirrors that rule ONLY to avoid offering a button guaranteed to
      fail - the host stays the enforcement, and a divergence surfaces as its
      error text rather than a silent deletion.
      - Three outcomes, not two: `hidden` (no remove scope advertised - a
        "can't remove" note on every row would be noise), `blocked` (supported,
        but not for this skill - worth a line, since the missing button would
        otherwise look broken beside removable siblings), `removable`.
      - Confirmed through `ConfirmDestructiveDialog`, stacked over the open
        skill dialog. The confirmation names the **path**: removal deletes a
        directory, and which of the four skill roots it sits in is what the name
        alone cannot say.
      - Removal has its own handler rather than reusing `runMutation`, because
        its outcomes land elsewhere: success closes BOTH dialogs (the open skill
        no longer exists, and its `readFile` would point at a deleted path) and
        must not touch the create/import draft fields; failure closes only the
        confirmation and renders inside the skill dialog, since the tab's own
        error banner sits behind it and would be invisible.
  - **Model Providers is the visual layer of `opencode auth login`**
    (`provider-model-providers-tab.tsx` +
    `provider-model-provider-connect-dialog.tsx`): the UPSTREAM LLM credentials
    a provider calls with, not a Traycer account and not a CLI binary. Backed by
    four dedicated RPCs on the optional-capability channel
    (`providers.listModelProviders` / `modelProviderAuth` /
    `awaitModelProviderAuth` / `cancelModelProviderAuth`) through
    `useHostQuery` / `useHostMutation`, with keys in
    `lib/query-keys/model-providers-query-keys.ts`.
    - **The tab exists only when the host says so.** It rides `supportedTabs`
      like every other wire tab, and only the `opencode` module advertises it -
      so an old host, an old CLI below the version gate, or any other provider
      simply has no tab. There is no client-side derivation that could disagree.
      It sits after `env` and before `mcp` in `PROVIDER_TAB_ORDER`: it is
      configuration (what this provider can reach) rather than an inventory of
      what is installed into it, and that position cannot move any provider's
      DEFAULT tab, since every provider advertising it also advertises the tabs
      ahead of it.
    - **NO scope picker**, unlike MCP. OpenCode's upstream auth is per-user;
      there are no project-scoped credentials for a `global`/`project` control
      to choose between. The sidebar host picker still scopes the tab.
    - **ONE list, connected first** (`sortModelProviderEntries`), not a
      "Connected" section above a searchable catalog. Search has to be able to
      find a connected provider, and the two-section shape is precisely the one
      where it cannot. ~180 rows flowing in the panel's own scroll (no internal
      height cap - an inner `overflow-y-auto` nested a second scrollbar inside
      the panel's); deliberately NOT virtualized
      (single-line rows, no per-row queries - and a virtualizer renders an empty
      viewport under jsdom's zero-height layout, which would put this list's
      behavior beyond test).
      - **One filter beside the search box**
        (`model-provider-filter.ts` + `model-provider-list-controls.tsx`):
        **All / Browser sign-in**, in the same `ListFilter` menu shape the
        provider rail uses (`provider-rail-controls.tsx`), down to the dot that
        marks an active filter and the trigger's accessible name carrying the
        current value. Per-row method badges were the other option and would
        have lit "API key" on ~170 of ~180 rows to say nothing — the failure the
        removed per-tab content dots had. The interesting answer is the rare
        one, so it lives one click away instead.
        There is deliberately **no "API key" option**, and it is the same
        argument one step further: the host synthesizes an `api` method for
        every provider whose `/provider/auth` advertises nothing, so that bucket
        measured **178 of ~180 rows** against a real host. A control that costs a
        click and returns the list you were already looking at is a dead option
        wearing a choice's clothes; "All" is the honest name for that set, and
        the two rows it would have excluded are exactly the ones **Browser
        sign-in** already isolates. The remaining bucket reads off `methods[]`,
        and an EMPTY method list means the host offered nothing at all.
        Filtering runs BEFORE the fuzzy search, so a query cannot quietly
        re-widen the bucket the user picked.
    - **`source` is badged only for a CONNECTED provider, and disconnect is
      gated on `canDisconnect` ALONE.** The host reports `source` as null unless
      connected, so a badge anywhere else would claim a credential origin the
      row does not have. `hasStoredCredential` answers a different question
      ("does Traycer hold a credential?") than `canDisconnect` ("may it be
      removed from here?"); a later host may answer them differently, and
      reading either for the other is how a button appears that the host will
      refuse. The host answers `source ∈ {api, custom, config}`. `api` and
      `custom` are auth-store removals (`api` for a key written through
      `auth.set`, `custom` for a provider whose loader is fed by that same
      store — `xai` signs in through OAuth and reports `custom`). **`config` is
      disconnectable too, and it is a CONFIG WRITE**: a config row has nothing
      for `auth.remove` to take, so the host suppresses it through
      `disabled_providers` — the same mechanism a declared custom uses, and for
      the same reason. That is true whether or not the row is a declared
      custom; an earlier version of this doc said config rows were read-only
      unless declared, which stopped being true when the host closed the
      key-only-config hole. **`env` stays read-only**: it is not ours to remove
      and no file write can suppress it. The control is a **text button reading "Disconnect"** —
      upstream's own word — with hover-only destructive tone (the pattern
      `provider-cli-candidates-section` and `env-override-editor` already use:
      quiet among neutral rows, red under the pointer). It was an unplug ICON
      with a tooltip until the user's manual pass, and it was the one control on
      the surface they could not read: a glyph in a row of quiet text names
      neither what it removes nor that it is the destructive one. The confirm
      dialog carries the nuance the tooltip used to — for an ordinary row it
      removes the stored key and the row may come back CONNECTED from an env var
      or config block underneath, so it promises removal and nothing more.
    - **A connected row shows ONE action.** Connected and disconnectable ⇒
      "Disconnect" alone, which is upstream's shape; replacing a stored key is
      disconnect-then-connect there too. The single exception is a connected row
      the host will NOT disconnect (an `env`-sourced one): it keeps "Connect",
      because parity's one-action rule would otherwise leave it with no action
      at all — a dead end that neither explains itself nor lets the user put a
      credential in place for when the variable is gone.
    - **Badges use upstream's vocabulary**: `env` → **Environment**, `api` →
      **API key**, `custom` → **Custom**, and `config` → **Config** or
      **Custom** depending on the entry's `configDeclaredCustom` flag. That flag
      is the host's copy of upstream's `T(id)` predicate (a `provider[id]` block
      whose `npm` is `@ai-sdk/openai-compatible` with a non-empty model map) and
      it is not recoverable from `source`, which lumps "the user declared this
      endpoint" together with "a config file supplies this key". The badge is
      now the row's ONLY origin marker; the trailing "Set by environment" /
      "Set in config file" line is gone, because a badge reading "Environment"
      beside a label reading "Set by environment" spent the row's last words
      saying one thing twice. The provenance sentence survives in the badge's
      tooltip, which is where a sentence belongs.
    - **The list is FLAT.** One `<ul>` with hairline separators, not a bordered
      card per provider: at ~180 rows a border around each turns the surface
      into a wall of boxes with the provider names as the smallest thing in it.
      The user's words were "boxy design is kinda bad, too many items", and the
      per-row status dot for a DISCONNECTED provider went in the same pass — an
      absent dot says the same thing as a muted one.
    - **`source` is a STATUS, not a permission.** An `env` / `config` / `custom`
      row shows where its current credential comes from and still offers Connect.
      An earlier pass blocked the write affordance on those rows, reasoning that
      OpenCode resolves env before its own auth store so a key saved here would
      be shadowed and the click would appear to work while changing nothing.
      The precedence is real — observed live, an account holding a stored
      `openai` OAuth credential still reports `source: "env"` while
      `OPENAI_API_KEY` is exported — but blocking was the wrong response to it.
      Setting a provider up and choosing which credential wins are different
      decisions: a user may want the OAuth sign-in in place for when the
      variable is not exported, or intend to unset it afterwards. OpenCode's own
      app configures any provider regardless of its current source, and ours
      refusing to was a restriction we invented. The connect dialog now leads
      with a warning naming what outranks it (`credentialPrecedenceNotice`,
      naming the actual variable) instead.
      `custom` gets its own wording rather than sharing the config-file line:
      that loader is frequently fed by the auth store — `xai` signs in through
      OAuth and still reports `custom` — so pointing at a file would send the
      user where the credential is not.
    - **Rows carry the provider's BRAND MARK**, from `@lobehub/icons` via a
      hand-owned `models.dev id → component` map
      (`home/pickers/model-provider-icons.tsx`, beside the harness map that uses
      the same package). Monochrome variants, so rows tint with the surrounding
      text; sizing follows the row (`size-4`).
      **Coverage is the popular head, and the tail falls back on purpose.** The
      fallback is **sparkles** — the mark users already read as "provider with
      no logo" in OpenCode, so the visual language carries over. What does NOT
      carry over is the reason it is broken there: upstream fetches
      `models.dev/logos/{id}.svg` at build time, that endpoint answers 200 for
      any id with a generic sparkles body, and the result is that 14 of their 98
      sprite entries are the fallback wearing a named provider's identity — and
      the fallback happens to be Synthetic's real logo, so an unknown provider
      renders as that company. A user-declared custom provider gets the same
      neutral mark, for the same reason: it has no brand, and borrowing one puts
      a real company's logo on someone's private gateway.
      **A DECLARED row never gets a brand mark, whatever its id.** The host's
      `isConfigDeclaredCustom` judges a block by its `npm` and model map, never
      its key, so a hand-written `provider.openai` block pointing at a private
      endpoint is a legal custom declaration under a mapped id — and painting
      OpenAI's logo on it is the same impersonation the neutral fallback exists
      to prevent, arriving through the one door the id cannot close. The mark
      takes `configDeclaredCustom` alongside the id for exactly that case.
      On the drift bug, precisely: a key MISSING from the map falls back (that
      is correct, and the expected fate of most of the catalog), while a
      reference to a component that does not exist fails to compile. Neither is
      a coverage guarantee — nothing here promises an id has a mark — but
      between them there is no state where a mark is claimed and nothing
      renders, which is what upstream's `llmgateway` does.
    - **A post-mutation refetch SAYS it is refreshing.** The host rotates its
      managed server on every write, so the next list pays a cold
      `opencode serve` boot — **measured ~3.7s, against ~0.24s warm**. For that
      whole window the rows on screen are the pre-mutation answer. The list
      keeps them (they are mostly right, and a skeleton would discard more than
      it protects) but dims them, sets `aria-busy`, and shows a "Refreshing
      providers" line. Without it a stale row reads as final, which is exactly
      what the user reported twice — "still needs manual refresh", then "it
      takes a little time to auto refresh".
      **No optimistic flip.** Disconnect does not reliably mean disconnected:
      an env variable or a config block underneath can keep the row connected,
      and the host decides that across five ordered passes. Guessing the outcome
      client-side would show a state the refetch contradicts seconds later — a
      visible flip-flop, and a re-run of the "client re-derives host truth"
      mistake this surface removed once already.
    - **The custom-provider dialog MIRRORS upstream's**, extracted field for
      field from OpenCode desktop 1.18.2 (`CustomProviderForm` /
      `validateCustomProvider`). An earlier pass mirrored their predicates and
      invented the form around them; the user's verdict was that this is not
      parity, and it was correct. Fields, in order: **Provider ID**
      (`myprovider`, "Lowercase letters, numbers, hyphens, or underscores"),
      **Display name** (`My AI Provider`), **Base URL**
      (`https://api.myprovider.com/v1`), **API key** (optional, "Leave empty if
      you manage auth via headers"), then **Models** — rows of `model-id` +
      `Display Name` with a trash per row and "Add model" — then **Headers
      (optional)** — `Header-Name` + `value`, same shape. Submit reads
      **Submit**. The intro links their own
      [provider config docs](https://opencode.ai/docs/providers/#custom-provider).
      `npm` is not a field: the host writes the one constant `T(id)` recognizes.
      Their rules, adopted verbatim including the loose edges — parity on a
      validation rule means taking its edges too, or "same form, same values"
      becomes a Traycer-only failure:
      - id `^[a-z0-9][a-z0-9-_]*$` — **underscores are legal**; ours banned them
      - base URL is a `^https?://` **prefix test**, not a URL parse
      - every model row needs an id AND a display name; ids compare
        case-sensitively (they are sent verbatim), header names
        case-insensitively (HTTP says so, and two rows differing only in case
        would collapse when written)
      - a wholly empty header row is skipped, not flagged — the list always
        carries one and the section is optional
      - the exists-check is SKIPPED for an id in `disabled_providers`: upstream
        re-enables a disabled custom provider by re-declaring it
      - **create stays a NAMING surface even then.** Re-declaring over a
        disabled id skips the exists-check, but not the minting pattern: the
        wire keeps the regex on `createCustom` and drops it only on
        `updateCustom`, and the client's two id policies match that split. So a
        disabled id we could never have minted - a dotted `wafer.ai`, say - is
        repaired through **Edit** or turned back on through **Connect**, not by
        retyping it into the create form. Imposing our naming style on an id
        already in someone's config is the thing that rule was never for.
      - `{env:VAR}` in the key field is a REFERENCE, not a secret — it becomes
        `env: ["VAR"]` and stores no credential
        **Submit stays live and validates on click**, which is upstream's shape
        and also the way out of the dead-button trap: a Submit disabled until
        valid is dead on a blank form for exactly the errors a blank form has, and
        nothing on screen says why. Nothing is red until asked.
        This REPLACES an earlier rule on this surface that disabled Submit while
        the draft was invalid. That rule was written before upstream's form had
        been read, and it was answered by marking every field pre-dirty on edit -
        a workaround for a problem the shape it was copying does not have. Both
        halves of the pair went together, so neither survives alone: reinstating
        the disabled button reinstates the invisible reasons.
    - **TWO DELIBERATE DIVERGENCES from upstream, both documented here because
      the extraction is the evidence for everything else on this surface.**
      1. **Edit exists; theirs does not.** `DialogCustomProvider` always mounts
         blank — upstream's only route back into a declaration is re-declaring
         it while disabled. Ours opens the form on the row's current values with
         the id locked, which is strictly more capable and is the only way to
         repair a hand-broken declaration. The id stays locked because it is the
         config key every stored model reference is built from; a rename would
         be a delete and a create wearing one button.
      2. **Write order is ours.** Upstream `auth.set`s the key and then writes
         the config, so a failed config write leaves a stored credential behind.
         The host does config first, key second — the same two operations
         failing in the direction where nothing is left over.
         **Edit opens with an EMPTY key field**, because the read side carries no
         key — credentials are write-only on this surface. Empty therefore means
         "leave the stored one alone", never "clear it", and the helper text says
         so in edit mode. An env REFERENCE is restored verbatim: it is not a secret,
         and blanking it would silently drop it on the next save.
    - **Edit can ADD and CHANGE; it cannot REMOVE.** The write is a deep merge,
      and removal is not something the provider's API can express — probed, not
      assumed. A null model entry is answered with a 400; a null header value is
      _accepted_ and stores the literal null, poisoning a file the provider's own
      CLI reads. Their own app never hit this because it has no Edit at all, so
      removal was never in the contract their API was written to.
      So a row already in the config is **locked**: no trash on it, and its KEY
      is read-only while the value beside it stays editable. The key lock is the
      non-obvious half and it is not fussiness — under a deep merge a key rename
      is **a removal wearing a rename**: the payload adds the new key and nothing
      deletes the old one, so one edit yields two entries plus an orphan the user
      can now never remove. Renaming a model's display name or changing a
      header's value carries no such risk, which is exactly why the row splits
      down the middle rather than locking whole.
      The trash is **gone, not disabled**, on those rows: a disabled control says
      "not right now", and this one can never enable. The section note carries the
      honest route instead — disable the provider and declare it again under a
      new id. Rows added during the session keep their trash until save, since
      nothing is stored under them yet, and **create mode is untouched**:
      everything is removable before it is written. A stored key is also left
      UNJUDGED by validation, for the same reason an existing provider id is —
      the field is read-only and the file is hand-editable, so a complaint there
      is one the user cannot act on; it still enters the duplicate set, so a NEW
      row colliding with it is flagged on the row that can change.
      The host refuses removal-shaped updates with `invalid_input` as a backstop
      for a stale client, and that detail renders **on the form**, which is the
      only surface that can say which key went missing.
      `env` is the one genuine exception, and it has **three** states rather than
      two: `null` leaves the declaration alone, `[]` CLEARS it, non-empty
      replaces it. The gap between the first two is the whole point — deleting
      the block's `env` key server-side needs an explicit signal, which forces
      `[]` to mean clear, so if ABSENT meant the same thing then every edit that
      touched only the display name would silently delete how the provider reads
      its key. An untouched form therefore sends `null`, which is also what
      retired the old `originalEnv` resend: that field existed only because
      "untouched" had no spelling of its own, and one field could never show
      several fallbacks anyway. An emptied field sends `[]`, and the edit-mode
      hint names both halves rather than promising an empty field is always
      harmless. **Re-enable sends `null` too** — it is not an env instruction,
      and echoing the read side's array back would be a replace-with-identical
      whose empty case arrives as CLEAR.
    - **`config_unreadable` is gone from both model-provider vocabularies** (it
      survives in `ProviderNativeErrorCode`, which is the MCP/plugins/skills
      config-write path and a different enum). A config the provider cannot
      parse is a server that never boots, so the condition was never separately
      observable here: it arrives as `server_unavailable` carrying the redacted
      parse error — file, line, column — and the detail-preferred rule renders
      that instead of the generic sentence. The fallback stays TRUE for a bare
      code rather than becoming a wrong-bug answer: a config the parser rejects
      is a server that failed to start.
    - **The global "All providers" status lives on the panel HEADING row**, and
      renders only when `isHostScopeUsable(scope.status)`.
      `latestProviderCheckedAt` is a max over every provider and Refresh
      re-probes all of them; at the card's top-right it sat inches from the
      selected provider's Enabled toggle and read as that provider's own.
      The safety argument is the boundary, not the location. `headerAction` is a
      SIBLING of the gate, so it is not gated — but `HostRuntimeContext.Provider`
      wraps this entire shell, header included, whenever the scope resolved a
      client, and `following` needs no override because the ambient client
      already IS the scoped host's. The two usable states are therefore both
      correct, for different reasons, and the three unusable ones
      (`connecting` / `unreachable` / `vanished`) mount nothing at all.
      The original bug was mounting these hooks in the header
      **unconditionally**: with no client, `useHostClient()` fell back to the
      ambient host and Refresh re-probed and rewrote the provider list of a host
      the page was not showing. An earlier fix over-corrected by banning the
      placement outright — and pinned "not in the header" as a test, which
      forbids the safe implementation rather than the unsafe state. The test now
      asserts the real invariant: no control and no request while the scope is
      unusable.
    - **Structure: ONE scroll context, plain search, Add as the first row.**
      The list no longer caps itself against the viewport or scrolls
      internally — that nested a second scrollbar inside the panel's own, so
      one list had two tracks and the outer one moved the tab while the inner
      moved the rows. The panel scrolls; the list just gets long.
      The search controls are an **ordinary control in the header area** that
      scrolls with the tab — the Skills tab's shape, where `ProviderListSearch`
      is a plain sibling above its list.
      **REVERSED, and worth the record.** Sticky was requested (the panel owns
      the only scroll context, so on ~180 rows the controls scroll away), built,
      and then retired on the user's live pass. Pinning requires a fill, since
      rows scroll underneath; this pane is `bg-card/40` composited over the
      settings background, so the sticky child had to repaint BOTH layers to
      look like the surface it covers. The first attempt (`bg-background/95` +
      backdrop blur) was a different colour and read as a lighter band. The
      second used the pane's own recipe and was correct in the middle, but the
      fill stopped at the padded container's edges, leaving a visible seam
      beside the input. Two failures with the same root: a pinned child cannot
      reproduce a composited translucent parent it does not own the bounds of.
      The accepted trade is scrolling back up to search a long catalog — one
      gesture, versus an artifact on every frame.
      **"Add custom provider" is the list's FIRST item** and scrolls with the
      content. It stays rendered whatever the search or filter says — including
      when they match nothing, which is why every empty state renders INSIDE the
      list shell rather than instead of it. It is an affordance, not a result:
      a query that hid it would remove the one row whose purpose is "what you
      want isn't in this list", exactly when someone is typing. (It sat above
      the search box for one round, for that same reason; the user's live pass
      overruled the placement, and the always-first-row form keeps the property
      without pinning it.)
    - **Disconnect on a declared custom row is a DISABLE**, and says so. There
      is no separate remove verb on the wire: upstream's disconnect for a
      config-declared custom disables the block rather than deleting a
      credential it may not have, so the confirm promises that the declaration
      stays in the config file and can be turned back on.
    - **ACCEPTED RESIDUAL: a `custom` row can have nothing to remove.** Upstream
      assigns `custom` from two different passes, and only one of them requires
      a stored credential: a plugin auth loader (guarded on an `auth.json` entry
      existing) and an AUTOLOADING provider loader (guarded on nothing). The
      wire's `source` cannot tell them apart, so `{api, custom}` shows Remove on
      the second kind too — the live example being OpenCode's own `opencode` row
      on a free plan, connected with no `auth.json` entry at all. The failure is
      the mild direction: `auth.remove` no-ops, the row re-lists as connected,
      and nothing is misreported. Being exact would mean reading `auth.json` key
      names, which the plan defers. Special-casing the `opencode` id was
      considered and rejected — that is the hardcoded-id rule the plan bans, and
      upstream's own version of that filter turns out to be a PAID-PLAN check
      (`m.id !== "opencode" || Object.values(m.models).find(v => v.cost?.input)`,
      the same predicate as their `paid()`), not a credential one, so mirroring
      it would import their monetisation rule and still not make us exact.
    - **Every provider gets the same plain masked key field**, unless it
      advertised a method list saying otherwise. There is no client-side notion
      of which providers "can" take a pasted key: `connect` sends
      `{ key, inputs }` where `key` is the SECRET VALUE (upstream's
      `ApiAuth.key`, which reads like an identifier and is not one) and `inputs`
      is the prompt answers keyed by prompt key.
      A `credentialKey` field used to ride the wire, derived host-side from
      models.dev `env[]`, and the dialog suppressed the key field wherever it
      came back null — Amazon Bedrock and both Vertex rows. The parity audit
      called it what it was: a ~130-line heuristic standing in for knowledge we
      do not have, for a requirement upstream does not have. OpenCode's
      `auth.set` stores whatever is pasted, and a credential that cannot work is
      the user's to discover. It is deleted across all three layers.
    - **The plain path is still suppressed when a provider advertises ANY
      method** — that rule is genuine upstream parity and stays. A provider with
      a method list has told us exhaustively how it can be authenticated, and
      every one that accepts a pasted key advertises that explicitly (`openai`,
      `xai`, `poe`, `gitlab`, `digitalocean`, `snowflake-cortex` all carry a
      "Manually enter API Key" arm). `github-copilot` advertises `['oauth']` and
      nothing else, so synthesizing a key field for it would invent a path
      upstream does not have. Verified against a live `/provider/auth`.
      Two consequences worth stating: the env-precedence warning no longer names
      the variable (that name came from `credentialKey`, and guessing it would
      be worse than the general statement), and the connect dialog's "this
      provider offers nothing" body is gone as unreachable — a provider
      advertising no methods now always has the synthesized key path.
    - **The prompts DSL is evaluated client-side**
      (`model-provider-prompts.ts` - pure, so it is tested without a form).
      Visibility resolves SEQUENTIALLY and only a visible prompt's answer feeds
      a later `when`: the form is a CLI prompt loop rendered at once, so a
      question never asked has no answer, and a field predicated on it must stay
      off screen. An unanswered key fails `neq` as well as `eq`. Hidden fields
      contribute nothing to the request - the host rejects any key the selected
      method did not ask for.
    - **OAuth attempt state lives in `model-provider-pending-auth-store.ts`**
      (mirrors `mcp-pending-auth-store.ts`), keyed
      `(hostId, providerId, modelProviderId)` and carrying the host-minted
      `attemptId`. `hostId` is in the key even though the HOST keys its own
      registry without it: the host only speaks for itself, while this store is
      one client-side map spanning every host Settings can point at — without it
      a sign-in started on host B overwrites host A's record, and A resumes
      against an `attemptId` that names nothing there. Removal is
      attempt-guarded for the same class of reason: every teardown resolves
      asynchronously, so a late cancel must not delete the record of the newer
      attempt that legitimately replaced it.
      - **Two lookups, deliberately not one.**
        `findModelProviderPendingAuth` answers "which row should re-open BY
        ITSELF" (newest on this host+provider); `getModelProviderPendingAuth`
        answers "does the row the user just clicked have an attempt" (exact
        full key). Two upstream providers can each hold a live attempt at once,
        so collapsing them made the OLDER of the two restart-only: its record
        sat in the store and the host held its server lease, but the only
        lookup available could never name it.

      `attemptId` is also what makes a resumed panel honest:
      attempts are single-flight per `(providerId, modelProviderId)` and a newer
      one supersedes the pending one, so a panel polling by key alone would be
      handed the newer attempt's status as its own. The tab adopts a stored
      attempt during RENDER, guarded on the entry map's identity - the same
      pattern as the MCP tab's `useResumeOauthPolling`, and what makes the panel
      re-openable across navigation yet still dismissible.

    - **Two OAuth arms, and neither is faked.** `code` shows the provider's own
      `instructions` verbatim plus a paste field; `auto` completes on the
      server's loopback and shows a waiting state with a bounded poll and a
      **Stop waiting** button - honest wording, because upstream has no
      OAuth-cancel endpoint.
      - **Only the START path opens a browser.** The host answers a
        still-pending poll with the STORED `authorizationUrl` rather than
        `{kind:"pending"}`, so a client re-attaching after a navigation can
        still show the provider's page. That is the right wire shape and the
        wrong thing to open a tab on, so the dialog carries an explicit policy
        (`applyStartResult` vs `applyPollResult`) instead of inferring one from
        the arm: a tick refreshes the panel and the resume record, and only a
        user action reaches `openExternalLink`. Handling both in one place
        reopened the sign-in page every 1.5s, on a flow the user was already in.
      - **Polling is single-flight**, scheduled from the previous tick's
        settlement rather than on a `setInterval`: an interval keeps firing
        through a slow request, stacking concurrent polls on one attempt — each
        re-leasing the managed server this whole design exists to stop churning.
      - **A terminal failure REPORTED BY A POLL ends the attempt.** The same
        `report` disposition means opposite things depending on who asked: from
        a submit it is advice against an attempt the host is still holding, so
        the panel stays put and the user can try again; from a status read it is
        a post-mortem, because the host only answers that way once the
        background callback has already failed and released its lease. Applying
        it identically left the panel saying "Waiting" against a settled row
        forever, with nothing further to arrive and no live attempt for Stop
        waiting to cancel. `applyResult` therefore takes the call context, and a
        polled `report` clears the attempt (attempt-id guarded), stops the poll,
        and returns to a fresh start with the reason kept on screen.
      - **Stop waiting keeps the attempt until the host CONFIRMS.** An
        optimistic teardown left a live host attempt holding a server lease with
        no surface able to retry when the cancel failed in transport. A
        confirmed cancel (`{cancelled: true, result: done}`) is LOCAL teardown —
        `done` describes the cancel, not a credential, so it neither closes the
        dialog as a success nor invalidates any cache. Only the
        `cancelled: false` race (the browser callback landing while the click
        was in flight) actually wrote a credential, and that one does both.
    - **Typed failures map to four distinct moves**
      (`modelProviderAuthErrorDisposition` in
      `lib/providers/model-provider-error-copy.ts`): `attempt_superseded`
      stands down SILENTLY (a
      newer attempt owns the surface - reporting it accuses the user of breaking
      the flow they just restarted), `attempt_expired`/`attempt_not_found` offer
      a fresh start, `code_rejected` re-prompts and KEEPS the live attempt, and
      everything else is reported. That mapping is the enum's contract restated
      as behaviour in one place, instead of a switch per call site that handles
      half of it.
    - **A cold list can be a WAIT rather than a failure.** Reaching the catalog
      needs the managed server, so every reason it would not start arrives as
      one `server_unavailable` - including a provider pack still downloading.
      The tab is handed the provider row's `providerPackPreparingForProvider`
      state and renders that case as loading-with-reason.
      `capability_unavailable` gets no Retry button: the surface is not offered
      here at all, and a click that cannot work is the offered-then-failed shape
      the rest of this panel refuses.
    - **Mutations invalidate the model catalog, not the harness list.**
      `agent.gui.listModels` is `staleTime: Infinity` by design, so without the
      invalidation the model picker would serve the pre-connect list for the
      rest of the app session - the one place the user looks to confirm the
      connect worked. `agent.gui.listHarnesses` is left alone: an upstream
      credential does not change which CLIs are installed, and re-probing every
      harness is the fan-out `useRefreshHarnessCatalog` keeps behind an explicit
      user action.
- `Notifications` Two `SettingsGroup` cards. A design pass
  (`settings-related-panels-core-flows` artifact) replaced the old one-column
  severity×channel matrix with a compact policy card, and gave the hooks
  manager below it the remaining height.
  - **`"In-app notifications"`** (the `· Current host` qualifier is gone - the
    sidebar names the host now, and the old suffix qualified the one fact the
    screen refused to resolve): three rows, one per severity
    - `Needs action`, `Failure`, `Done` (`info` has no row) - each a single
      `Switch` gating durable host-row creation before anything reaches the bell
      feed, unread count, tab indicators, or notification hooks. Collaboration
      and app-local notifications stay independent. Backed by
      `host.notifications.getConfig` / `setConfig` through host-scoped TanStack
      Query hooks. The wire contract still carries a full severity×channel
      matrix (including an `email`/SMTP channel that is never surfaced here,
      round-tripped untouched via a `leaveUnchanged` password sentinel) - this
      panel only renders and toggles the `renderer` channel; a real multi-
      channel UI is deliberately deferred, not an oversight (the artifact notes
      a channel-by-severity matrix "is reserved for a future surface with
      multiple user-configurable channels").
  - **`"Notification hooks"`** (`notification-hooks-section.tsx`): a toolbar
    (hook count, a copy-config-path chip, Refresh, Add hook) over a row list
    that owns the remaining height (`fillHeight` on the shell +
    `min-h-0 flex-1` down the tree - only the row list scrolls, the toolbar
    stays pinned). The config-path chip consumes the toolbar width left after
    the count and actions, truncating only when that real remaining width is
    exhausted. The no-hooks state fills and centers within the list viewport.
    Each row shows name, a Script/HTTP type badge, destination,
    severity filter (or "Every severity"), latest test result, an inline
    enabled `Switch`, and inline **Test / Edit / Delete** buttons (not a row
    action menu) - Delete confirms via `ConfirmDestructiveDialog`. Edit/Add
    open the pre-existing hook editor dialog (`notification-hook-editor-
dialog.tsx` / `notification-hook-draft.ts`, unchanged by this pass).
    States: a loading spinner; a neutral "unavailable, reconnect" message when
    the host is unreachable; the query's own error message; an empty state
    with its own "Add hook" plus the toolbar's; and, when the hooks file
    itself fails to parse, the row list is replaced by the parse error with
    editing disabled while the config-path copy chip stays available (the
    invalid file is never overwritten). A running test spins only on the
    tested row, but the Test button on every OTHER row is also disabled while
    any one test is in flight (the mutation is global, not per-row) - worth
    knowing if this ever reads as a bug report.
- `Agent selection` (section id `agents`, route `/settings/agents` - both kept as
  compatibility identifiers) Editor for the **global** agent selection guide
  (`~/.traycer/agent-selection-guide.md`) - the instructions Traycer agents read
  to decide which child agents to spawn (coding agent / model / reasoning
  effort) for a task. The section is named for _selection_ because it configures
  how an agent is chosen, not the Agents that live inside a Task; the panel
  description says so. A full-height CodeMirror Markdown source editor provides syntax
  highlighting and line numbers, including for Mermaid and wireframe fences.
  It debounce-auto-saves (and flushes on blur) via
  `agent.selectionGuide.setGlobal`; a quiet "Saving… / Saved" status sits in the
  footer, no Save button. A **Revert to default** button (disabled while the
  content already equals the provider-based default) calls
  `agent.selectionGuide.resetGlobalToDefault` behind a `ConfirmDestructiveDialog`.
  The editor has NO host selector of its own - the sidebar switcher scopes it.
  It reaches non-active hosts with a transient `useHostClientFor` context
  override and remounts on `scope.hostId` so one host's file never carries into
  another; the whole subtree stays unmounted until `isHostScopeUsable`, so the
  guide query cannot fire against the ambient host. Backed by
  `agent.selectionGuide.getGlobal` (returns `{ content, generatedDefaultContent }`),
  `agent.selectionGuide.setGlobal`, and
  `agent.selectionGuide.resetGlobalToDefault` through the agent selection guide
  hooks. The global guide is the only scope: per-workspace
  `.traycer/agent-selection-guide.md` overrides were removed (older hosts may
  still send them, current clients ignore them).
- `Keybindings` Keyboard shortcut customization.
- `Shell` Shell binary + args used for every terminal PTY
  (`TerminalSessionManager` reads the effective config per spawn, file-watched,
  so new terminals pick up changes immediately) and for provider-CLI PATH
  discovery. The host process itself is launched directly (its bundle
  executable, `host-start.ts` spawns it with `args: []`), NOT through the
  user's shell - so shell path/args do **not** affect the host bootstrap.
  Environment-variable overrides ARE merged into the host process env at
  `traycer host start` and therefore take effect on the host's next restart.
  Backed by the SELECTED host's own `config.shell.*` / `config.env.*` RPCs -
  local and remote alike, one code path - and by the local `traycer config`
  CLI (`IRunnerHost.traycerCli`) in the one fallback case below. Both transports
  implement `ShellConfigController` (`panels/shell/shell-config-controller.ts`)
  and the editor is written against that interface, so the two paths cannot
  drift into two different editors:

  - **RPC** whenever the scope resolves to a client. An unresolved scope still
    renders the gate, and a host that predates the methods renders
    `HostConfigUnsupportedNotice` - never this computer's values under another
    host's name.
  - **CLI bridge** only for `localConfigFallbackReason` (this computer's host,
    stopped or predating the methods), under `LocalConfigFallbackNotice`. Same
    on-disk store, so the values are still that host's.

  Two affordances are inherently local and degrade rather than lie: the native
  **Browse…** file dialog is offered only when the target machine is this one
  (`ShellProbeSource.pickProgramFile`; every other target types a path), and
  the "Add a shell" existence/executable probe runs on the TARGET host
  (`config.shell.probe`), not on this computer.
  - **Flags belong to a shell, not the panel.** Each program carries its own
    startup flags: `shell.entries` is a list of `{ path, args }` launch specs,
    and `shell.path`/`shell.args` are the selected command MATERIALISED for an
    EXPLICIT selection (the mirror invariant - see `protocol/config`). `args` is
    a DEVIATION: `null` means "runs the family default", so presence (an entry
    exists) and flag-deviation (`args !== null`) are independent - an added
    program on factory flags is `{ path, args: null }`. The store's write path
    canonicalises any args equal to `defaultShellArgs(path)` (`-i -l` for a login
    shell, none otherwise) down to `null`, which makes "the visible flags differ
    from the family default" exactly equal to "a non-null deviation is on disk".
    Picking a program swaps the flags row to that program's resolved flags.
    Picking is not remembering - only adding a program or editing its flags
    creates an entry. **"System default" is an alias for the login shell and
    INHERITS its entry flags**: in the pure-auto state (`path`/`args` both null)
    resolution reads the login shell's entry, and editing the flags row while on
    it configures that entry while staying auto (the mirror stays null/null so
    the System default row stays checked). **Nothing is forgotten by changing
    selection** - only the ✕ removes an entry; **Restore default flags** clears a
    shell's deviation (`args: null`) while keeping the entry.
  - **UI (Direction B - live-preview cards).** Two `SettingsGroup` cards under
    `panels/shell/`, each with an external scope label instead of an in-card
    title (a `settings-related-panels-core-flows` design pass; the underlying
    combobox/chips/editor components below are byte-for-byte unchanged): a
    **`"Terminal shell · New terminals"`** card with an `EffectiveCommandPreview`
    (terminal-styled `❯ <path> <args>`, reusing `--term-ansi-*`), a
    `ShellProgramCombobox`, and `ShellFlagChips` (labelled _Startup flags for
    &lt;shell&gt;_, with the "`-i -l` loads your full shell profile" helper only
    when the selected program is a login shell, and a quiet _Restore default
    flags_ action shown only while the visible flags deviate from the family
    default - reverting the SELECTED shell via `config.shell.revertArgs`). **On Windows hosts with WSL
    selected** (classified by binary via `windowsShellCaptionFamily`, shared
    with the host resolver) a single quiet line sits directly under the picker
    in its column - "Agents won't see tools installed in WSL", amber dot +
    `Info` glyph - with the explanation and the "run the Traycer host inside
    WSL" remedy link (docs.traycer.ai/settings/shell#using-wsl) in a
    `HoverCard`; the glyph is itself a focusable anchor to that docs page so
    keyboard users reach the remedy without the pointer-only hover card. Only
    WSL earns a caption: PowerShell / Git Bash profile loading and cmd's plain
    Windows environment are expected behavior, so those selections (and all
    non-Windows hosts) render nothing, and the picker row top-aligns only
    while the caption is shown. There is also a **`"Host environment ·
After restart"`** card with the shared inline `EnvOverrideEditor`
    (host-process scope only - set/unset mode, value edit, key rename, and
    staged add/remove; per-harness env lives in Settings → Providers). Existing
    env rows **auto-save on commit** (env blur/Enter); new env rows apply only
    when their check button is pressed. Other controls still auto-save on
    commit (row select, add, chip add/remove) - what changed is the feedback:
    the old permanently-visible "Saving… / ✓ Saved" text footer is gone,
    replaced by the same transient icon-only spinner/flash-check pattern as
    Worktrees' branch-prefix strip (`TransientSaveLiveStatus` /
    `TransientSaveIndicator`, ~1.6s flash, `sr-only role="status"
aria-live="polite"` carrying the equivalent text for
    assistive tech) - three independent instances (shell program, flags, env),
    each sitting inline in its own row/block rather than one shared card
    footer, since the old single shared footer is gone along with the in-card
    titles. **Restore default flags** is still the only reset-like control
    (relocated into the flags row); there is still no other reset button.
  - **The "system default" concept lives in exactly one place: the picker's
    first row.** It is not repeated as a preview badge, a trigger chip, or a
    footer button (all removed). `EffectiveCommandPreview` shows only the
    effective `❯ <path> <args>`.
  - **Shell picker (`ShellProgramCombobox`).** The trigger shows either
    **"System default"** + `{defaultName} · {path}` (when `config.synthesised`)
    or the stored shell's name + start-truncated path (otherwise) - no chip. The
    popover leads with a **System default** row, then one alphabetical list of
    concrete shells, then a labelled _Add a shell_ section:
    - **System default row** (first, present whenever the list has an OS-default
      entry, carrying `data-testid="settings-shell-reset"` migrated from the old
      footer button). Its check shows when `config.synthesised`; clicking it
      clears ONLY the selection via the controller's `resetShell`
      (`config.shell.reset`, or the CLI's reset in the fallback). The RPC path
      invalidates the detected-shell list alongside the config read - harmless
      and deliberate, since a reset can change which row is checked; the CLI
      path invalidates only the config read. Remembered shells and their flags are
      kept - the login shell's own entry is inherited - so the row stays checked
      even when the login shell has customised flags, and editing the flags row
      while checked persists to that entry without un-checking it.
    - **The concrete list** is `detectShells()` ∪ the user's `shell.entries`
      paths, resolved ON THE TARGET HOST (`config.shell.listDetected`, or
      `ITraycerCli.shellListDetected()` in the fallback; cached for the
      session), sorted purely
      alphabetically (the System default row owns the auto concept, so no
      default-first ordering or per-row "default" tag). A concrete row is checked
      only when a shell is explicitly stored (`!synthesised`) and its path
      matches; a hover/focus ✕ removes rows whose `source` is `"added"` (detected
      rows are never removable). An entry-derived row whose file has since
      vanished lists with `missing: true` - its path takes the amber
      (`--term-ansi-yellow`) validation tone with a quiet "not found" hint, and
      it stays selectable and removable (that ✕ is the cleanup path). A selection
      that is neither detected nor an entry (set by hand via the CLI) renders as a
      transient checked row without ✕. Clicking a row auto-saves via the set
      mutation, materialising that program's flags.
    - **Add a shell** is an always-visible path input with a live status line
      driven by a debounced probe of the TARGET machine (`ShellProbeSource`:
      `config.shell.probe`, or `ITraycerCli.shellProbe` in the fallback):
      non-absolute → "an absolute path is required"; found+executable → green
      "✓ found · executable"; the amber states ("found, but not executable" /
      "not found on this machine") **block the add**. Enter adds only from the
      green state (remember + select via `config.shell.add`, which invalidates
      both the config and list reads). A **Browse…** row runs a chosen file
      through the same probe gate - executable files are added outright, a
      non-executable pick is left in the input with its amber status - and is
      shown only when the target machine is THIS one (a native dialog can only
      name local paths); every other target types a path instead. The ✕ removes
      via `config.shell.remove`; the backend falls back to the OS default when
      the removed shell was current.
  - **Detection** (`protocol/config` `detectShells()`) unions `/etc/shells`, a
    probe set, `$SHELL`, and a scan of every `PATH` directory for known shell
    names; on Windows it scans `PATH` plus env-var-derived well-known locations
    (WSL, Git Bash, Store PowerShell) and `%COMSPEC%`, giving WSL/Git Bash
    friendly names. All candidates pass the same `X_OK` filter, realpath
    duplicates collapse (preferring the OS default), and detection never throws.
    Added/customised shells persist as `shell.entries` (additive config field,
    replacing the never-shipped `shell.added`) and are listed even when their
    file no longer exists (flagged `missing`). Env **rename** is client-sequenced
    (`envOverrideSet` new → `envOverrideDelete` old) with an inline unique-key +
    `/^[A-Za-z_][A-Za-z0-9_]*$/` guard.

- `Worktrees` Two stacked cards, no section headings: a compact **branch-
  prefix strip** (client-wide creation default) directly under the page
  header, then the **worktree inventory** (the pre-existing host-scoped
  management list, unchanged) taking all remaining height. Earlier this was
  two `settings-section-header.tsx`-banded sections labelled "New worktrees" /
  "Existing worktrees" inside one continuous card; a design pass
  (`general-settings-core-flows` artifact, following user feedback that the
  worktree list was starved of space in the modal overlay) replaced both
  headings with a genuinely compact strip and let the inventory own the rest
  of the pane - each card's own content (the strip's label + "All hosts" tag,
  the inventory's host/search/filter toolbar) already says what it is, so a
  redundant heading above either would just repeat that.
  - **Branch-prefix strip** (`worktree-branch-prefix-section.tsx`, backed by
    `worktreeBranchPrefix` in `settings-store.ts`, default `"traycer/"`).
    One control line: a **Branch prefix** label + a quiet **All hosts** scope
    tag, a live example line below it ("New branches start like
    **traycer/quiet-otter**"), then reset + a plain text `Input` + inline
    save feedback, all on the same row. The example previews
    `${draft.trim()}${suffix}` (an unprefixed suffix when the trimmed draft
    is empty) using a friendly two-word suffix
    (`random-friendly-name.ts#pickFriendlyBranchSuffix`) generated ONCE per
    mount and held stable while typing - only the prefix part changes as the
    user types, so the suffix itself isn't distracting noise. The input is
    used verbatim as the prefix for the branch name pre-filled when creating
    a new worktree - no separator is auto-appended, so the user types it
    (`traycer/`, `anurag/`, `feat-`); an empty value means no prefix,
    mirroring `composeDefaultNewBranch`'s existing "empty means skip"
    precedent. Accessible name is `"Branch prefix"` (renamed from the older
    `"Worktree branch prefix"` to match the new visible label - the page
    title already says "Worktrees", so repeating it in every control's name
    read as redundant under the new design).
    - **Debounced autosave, mechanics unchanged, presentation reworked.** A
      valid, changed draft still persists ~500ms after the last keystroke;
      Enter and blur still flush a pending save immediately. The draft is
      still the single source of truth while a local edit is in flight -
      tracked by an explicit flag (not string comparison, which breaks once
      a trimmed commit can make the raw draft and the saved value diverge by
      whitespace alone) - and still adopts an idle external write (another
      window, rehydration) once no local edit is in flight, normalizing to
      the trimmed value the same way a local commit does. What changed is
      purely the feedback surface: the old permanently-reserved "Saving… /
      Saved" status line is gone. A compact `AgentSpinningDots` spinner
      appears beside the input while a valid save is pending; on a
      successful write it becomes a brief `Check` (~1.6s, mirrors
      `SegmentCopyButton`'s `COPIED_RESET_MS` flash convention) then returns
      to quiet chrome with nothing reserved - the flash fires only for the
      current user's own resolved edit or the reset button, never for an
      adopted external write. An invalid draft shows a concise error on a
      persistent line BELOW the control instead, and only then does the
      strip's card grow a row to hold it; correcting the value removes the
      error and resumes autosave. The error text carries a stable id wired to
      the input's `aria-describedby` (only while an error is showing) and
      renders with `role="alert"`, so the failure state reaches assistive tech
      the same instant it reaches the eye. A ghost `RotateCcw` reset button
      occupies the same reserved `size-7` left gutter as the font-size rows in
      Appearance, appears whenever the ACTIVE DRAFT differs from the default -
      not just the saved value, so it stays available to cancel a pending or
      invalid in-progress edit even before anything has been committed - and
      on click cancels any pending debounce, writes the default immediately,
      flashes the same brief success check, and moves focus to the (still
      mounted) Input so it doesn't drop to `<body>` when the button itself
      unmounts. The spinner/check pair is
      visual-only (icon, `aria-hidden` where applicable), so a visually
      hidden `sr-only` `role="status" aria-live="polite"` span sits alongside
      it carrying the same "Saving…" / "Saved" text for assistive tech -
      mirrors the existing `PrimaryChangeLiveRegion` convention
      (`host-workspace-selector/primary-change-live-region.tsx`). Both the
      visual indicator and the live-region text are driven by the same
      explicit "local edit in flight" flag mentioned above, not by comparing
      draft/saved values - so a resolved edit that normalizes back to the
      already-saved value (pure whitespace) still flashes success, while an
      idle external write or an already-clean field's blur stays quiet.
    - **Next-use-only** (unchanged): changing the setting does not retrofit a
      branch name already pre-filled in an open composer/picker - it applies
      to worktrees configured after the change (newly resolved folders,
      freshly opened composers, submit-time composition), matching the app's
      seed-time-snapshot norm elsewhere (`composerMode` draft seeding,
      `applySeed`). Light client-side validation
      (`worktree-branch-prefix-validation.ts`) rejects an illegal git ref
      (spaces, ASCII control characters, `~ ^ : ? * [ \`, `..`, `@{`, a
      leading `-` or `/`, consecutive `//`), anything over 40 characters, and
      any slash-separated component that starts with `.` or ends with
      `.lock`, with an inline error instead of saving - git remains the final
      authority at branch-creation time. Re-validated again at the single
      composition choke point (`composeDefaultNewBranch`) and during store
      rehydration, so a hand-edited or corrupted persisted value falls back to
      the default instead of flowing verbatim into a branch name. The 40-char
      cap keeps the composed name's `.slice(0, 80)` truncation landing inside
      material that is always `[a-z0-9-]` - the random suffix, or (for
      multi-workspace names) the repo slug, which is ALSO capped at 40 chars
      and can itself be reached by the cut once prefix + slug exceed 80 - so
      truncation can never produce an illegal or empty ref and needs no
      post-composition repair. Threaded into `composeDefaultNewBranch`
      (`lib/worktree/default-branch-name.ts`) from the two worktree-picker
      call sites in `host-workspace-selector.tsx` and the cached-default path
      in `use-landing-composer-actions.ts`; entirely client-local, no host
      RPC or protocol change.
  - **Worktree inventory.** Host-wide management of the git worktrees Traycer
    creates under `~/.traycer/worktrees/`, presented as a calm
    inspection-and-cleanup list, not a delete console - own bordered card,
    no heading above it. The sidebar switcher scopes it - the toolbar holds no
    host control and no host readout - and the SCOPE's verdict outranks
    `useHostReachability`, which is the tab-binding check and can call a host
    reachable that this scope cannot dial. A disk-truth list -
    so orphaned worktrees whose owning agent was deleted still appear -
    grouped by repo under quiet, collapsible headers (`WorktreeRepoHeader`)
    that stay visually secondary to row status. The selected host is reached
    through a **transient per-host client** (`useHostClientFor`) so picking a
    host never swaps the app-wide active host or reloads the Epic list (and
    never affects the branch-prefix default above). Backed by the host
    `worktree.listAllForHost` RPC through `useHostQuery` / `useHostMutation`,
    and by the `worktree.deleteBatchByPath` stream for deletion: a single or
    bulk delete is ONE host-owned command that keeps running if this panel
    unmounts and writes one completion notification when every target settles.
    Against a host too old to know that method, the panel falls back to the
    released per-target `worktree.deleteByPath` stream, metered two at a time
    client-side. Setup/teardown script editing is NOT here - the create-
    worktree flow owns it, and scripts otherwise live in the committed
    `.traycer/environment.json`.
  - **Evidence tiers, not a safety verdict.** Each row leads with exactly one
    loud status pill (`WorktreeTierPill`, classification shared with the
    Task-delete dialog and the `traycer-housekeeping` skill via
    `classify-worktree.ts`) naming a PROVEN fact, never a generic "Safe"
    label. **Merged**, **At base commit**, and **Unreferenced** are the three
    green tiers - each requires positive, host-validated proof (a merged PR at
    the live HEAD, local ancestry into the default branch, or authored owned-
    submodule work proven landed from an otherwise at-base superproject; never
    advanced from the worktree's birth commit with no landed authored submodule
    work; or clean, fully pushed, and unreferenced by any Task) - and are
    deliberately kept distinct rather than collapsed into one badge. **Review**
    is the amber catch-all for anything unproven or
    with would-be-lost state (dirty, unpushed/local-only commits, a detached
    HEAD, an unmerged owned-submodule branch, or unverified branch status).
    **Orphaned** means git can't remove the worktree normally (missing/broken
    metadata) and its delete routes through a forced host-side `fs.rm`
    cleanup. **In use** means an active agent or terminal references it - both
    selection and delete are disabled, not just delete. Hovering any pill
    shows the concrete proof or reason (`WORKTREE_TIER_TOOLTIP`), and the
    risk-bearing facts behind a tier (uncommitted count, ahead/behind,
    detached HEAD, unmerged submodule) render inline on the row
    (`WorktreeSecondaryFacts`) without hover or expansion.
  - **`Checking` and `Unknown` are enrichment states layered on top of a
    tier, not tiers themselves.** A row's tier depends on host-probed
    branch/PR activity that resolves after the base list loads. While that
    probe is in flight the pill reads **Checking…** - dashed border, animated,
    full-contrast text, never the muted/green treatment a resolved-safe pill
    uses, because pending status must never look safe - and delete is
    disabled with an explicit "status is still being checked" reason; the row
    stays visible under an active status filter instead of silently matching
    or disappearing. If the probe settles to an error (host unreachable,
    git/gh probe timed out) the pill reads a static **Unknown** (amber,
    dashed, a distinct icon from Review so it never reads as a confirmed risk
    finding) - it remains deletable, but only through an explicit
    unknown-risk confirmation (`unknownRiskDeleteDialogCopy`) that names the
    branch/activity status as unverified, never the generic confirmation a
    proven tier gets.
  - **Delete is reached through a persistent row overflow**
    (`WorktreeRowActions`: copy path, manage scripts, delete, in that order)
    rather than a hover-only icon, so a resting row never shows a destructive
    affordance. Confirmation copy escalates with what the row actually risks -
    discard-N-uncommitted-changes, unpushed/local-only commits, the
    unknown-risk copy above, forced cleanup for orphaned rows, or a plain
    confirmation for a proven-green row (`deleteDialogCopy` /
    `singleWorktreeDeleteDialogCopy`). On confirm the row is re-checked
    against current state; if it became ineligible in the interim the delete
    is skipped and the user is told why instead of proceeding on stale
    information.
  - **Selection and bulk delete** use always-keyboard-reachable checkboxes
    plus a tri-state toolbar select-all toggle (`WorktreeSelectAllToggle`,
    scoped to currently-visible selectable rows) instead of a permanent
    header row. Selecting rows never inserts chrome above the list; a
    contextual selection bar (`WorktreeSelectionActionBar`) floats over the
    bottom of the list, out of flow, so entering or leaving selection never
    shifts rows under the cursor. If any selected row is still `Checking`,
    bulk delete is disabled with a count of how many are still pending. The
    bulk confirmation (`WorktreeBulkDeleteDialog` /
    `summarizeBulkWorktreeDelete`) aggregates the selected rows by class
    (never one warning per row), names concrete dirty-loss counts, adds a
    neutral unverified-branch-status caveat and a separate unknown-risk
    caveat for rows whose enrichment failed, and lists what was excluded from
    the selection (in-use, still-checking, or otherwise not selected).
    Confirm re-checks every selected row and skips/names any that became
    ineligible; in-use rows can never be selected or deleted, and explain why
    inline.
  - Background delete progress renders as a non-intrusive strip
    (`WorktreeDeleteProgressStrip`) that stays visible through partial
    failures until dismissed. A quiet `Task {label}` caption
    (`TaskMergeRollupBadge`) beside a resolved Task chip reports that Task's
    aggregate merge progress across every worktree it owns - deliberately
    plain muted text, not a colored badge, so it never competes with or is
    mistaken for the row's own tier pill.
- `Host` **Overview**: ONE page about one host - the scoped one - and the same
  page whether that host is on this desk or in a datacenter. The cross-device
  **My Hosts** list and the separate **This machine** section are both gone; the
  sidebar switcher is the collection, and every lifecycle verb lives on the
  Overview of the host it describes.

  **The page reads the scoped host's OWN RPC** (`host-overview-panel.tsx`):
  `host.status` for what it is running, `host.identity.get` for what it is
  called, `host.getInstallationInfo` for how it was installed; buttons are
  `host.restart`, `host.doctor`, `host.identity.set` and `host.update.*`. Local
  and remote render the SAME components from the SAME answers - that equivalence
  is the deliverable, and `host-overview-parity.test.tsx` pins it by rendering
  both variants against one set of RPC fixtures. Before this, the local CLI
  bridge (`runnerHost.hostManagement`) was the primary source, which is why a
  remote host got a thinner page describing it in a different dialect.
  - **Per-button degrade, never a page-level gate.** Each control asks
    `useHostMethodSupport` for its OWN method: an old host can have `host.status`
    and not `host.restart`; a current host on a box with no Traycer CLI can
    restart but cannot run doctor or update itself. The tri-state is load-bearing
    - `null` ("no handshake yet") must NOT degrade, because this page's own first
      RPC is what produces a handshake. A degraded button carries
      `data-degraded="<reason>"` and a tooltip naming the remedy, which differs by
      reason (`unsupported` → update the host; `cli-unavailable` → install the CLI;
      `externally-managed` → use the cloud pin). `useHostCapabilityProbe` keeps one
      bounded released-floor read mounted while any answer is a stale `false`, so a
      host upgraded in place under the same id can overturn it.
  - **Status card** = `HostIdentityCard`, the same component the remote path
    already used, now carrying a `nameAction` slot, a `sessionCount`, a verb bar
    plus a `displayName` and a `version` the caller decides. Both names follow
    the SAME two-layer rule: the host's own answer (`host.status`'s
    `hostVersion`) when there is a route, the registry/directory copy when there
    is not. Version is single-sourced to that identity line on purpose - it used
    to also appear in the endpoint line from a different source, so one card
    could show v1.4.2 (the registry row) above v1.5.0 (the RPC) at the same
    time, which reads as broken rather than stale.
    - **Layout.** Name, rename pencil and tags on one line; presence dot, health
      label, platform/arch/version and the sessions chip on the next; then a
      footer verb bar; then Host ID. Rename is a pencil ON the name rather than
      a third word beside Restart and Run doctor - it was the only one of the
      three whose object is the name, and as a peer button it read as an equally
      weighted maintenance verb. Its accessible name is still literally
      `Edit name`. The verb bar is a footer strip rather than a right-aligned
      header cluster because the header already carries a name, a pencil and up
      to two tags, and the two competed for one row at every settings width
      below full screen.
    - **The `ws://…`/pid meta row (`host-overview-endpoint`) is GONE**, and with
      it the page's one deliberate local/remote difference. It showed the
      loopback endpoint and pid locally, `via <relay host>` remotely; neither
      half is actionable from Settings - the pid names a process this page can
      only reach through the Restart button beside it, and the relay origin is
      infrastructure the account picked. What it carried that anyone acts on is
      the session count, which is now a chip on the identity line straight off
      `host.status.busySessionCount`: emerald and pulsing above zero, muted at
      zero, and ABSENT while the host has not answered, because "No active
      sessions" is a claim and silence is not. `host-overview-parity.test.tsx`
      is correspondingly stricter - `endpointText` is no longer a named
      exception, so the two variants now differ on the "This computer" tag and
      the danger zone's removal plane and nothing else.
    - **"Active for this window" is no longer a row.** A full-width bar with its
      own background asserted one boolean about the WINDOW on the page about a
      HOST. The binding is an `Active` tag beside the name; when this window is
      pointed elsewhere, `Use in this window` joins the verb bar and carries the
      asymmetry sentence ("Tabs you already have open stay on the host they
      started on") as its tooltip, where it is read at the moment of deciding.
      `ThisWindowCard` survives for the recovery console, which has no verb bar.
  - **Name precedence, in two layers.** Reachable → `host.identity.get`'s
    `effectiveName`; unreachable → the registry `displayName` the scope row
    already carries (`resolveHostName`, whose local-machine special case was
    REMOVED - see the host-scope model). Both are the same string on a healthy
    fleet, because the registry's copy follows the host's `effectiveName` over
    the presence heartbeat, so the hand-off is a settle onto the fresher of two
    agreeing sources rather than a blank being filled. The RPC path's draft rule
    differs from the bridge's on one case and deliberately: typing the machine's
    own name does NOT clear the override, because `effectiveName` folds a
    registration label that need not be the hostname. Dirtiness is measured
    against the SEED the input opened with, not against `customName` - on a
    labelled host (`{customName: null, effectiveName: "Build Box"}`) the form
    opens showing the label, and comparing that to `customName` made an
    UNTOUCHED form read as dirty: Save was live on open and one click froze the
    label into an explicit override nobody asked for. A no-op draft now neither
    enables Save nor issues a write.
  - **Restart** is claim-gated. The client mints a `transitionId` when the action
    is ARMED and reuses it for that action's retries - the host adopts a claim it
    already granted only on a matching id, which is what makes a retry after a
    lost ack idempotent instead of a busy refusal. `{outcome:"busy"}` is NOT an
    error: the host closed session admission, found work in flight and reopened
    it, so it renders as an amber notice with a Try again, never a red toast.
  - **Updates**: one card, both halves. The host's own "Check now" and the
    VERSION LIST it reveals (`host.update.*`) sit above the account registry's
    auto-update policy and drain-gate force (`HostRegistryUpdates`, keyed by
    `hostId`, controls capture their target when armed).
    - **The version list replaced a free-text pin.** `host.update.check` returns
      the whole manifest, not just `latest`, so the Overview renders the same
      per-row-Install list the local recovery console has always had - for a
      remote host too. Rows are `HostVersionRows`, shared with the bridge-backed
      `AvailableVersionsList`; each surface projects its own payload to
      `HostVersionRow` rather than one faking the other's shape (the RPC
      manifest has no `platformKey`/`manifestUrl`, and inventing them was the
      first attempt). An install in flight freezes EVERY row, which is where the
      old `showUpdateNowInput` guard went - it existed so a second
      `desiredVersion` write could not retarget a draining update.
    - The asset lookup takes a SOLE `platforms` key as authoritative: the host's
      CLI projects each entry to `currentHostPlatformKey()` before emitting it,
      so re-deriving a key here would get win32-arm64 wrong (it resolves to the
      emulated `win32-x64` build, which the registry row does not know). More
      than one key means an older CLI that emitted the whole map, and only then
      is the registry's platform string used - a miss reports "no asset" rather
      than guessing.
    - **What this gives up, stated:** the pin was applied by the host's own
      reconciler on its next check-in and so needed no route. Choosing from what
      the host reports does need one, so an OFFLINE host can no longer be
      pinned; the auto-update policy beside it still works without a route.
      `isValidHostVersion` (the client mirror of authn-v3's server-side regex)
      went with the input it validated.
    - Check stays a MUTATION, not a query: it spawns a process on the host and
      reaches the registry, so it runs when someone asks and not because a
      settings pane mounted.
    - The RPC half degrades away WHOLE - Check-now and the list with it,
      leaving the auto-update policy as the only update control, plus one line
      saying why - without the methods, without a
      CLI (`cli-unavailable`, from the check side or the install side), or on an
      `externally-managed` refusal. The last two are knowable only from an
      ATTEMPT, so they are discovered rather than negotiated, and once seen they
      are STICKY for the mounting: both are facts about how the host is set up,
      not about that attempt, and leaving Check-now behind would keep offering
      the one action the host has just said can never lead anywhere.
      `cli-failed` / `invalid-output` are deliberately NOT sticky - one attempt
      going wrong with the mechanism intact - so the controls stay and an inline
      `host-overview-update-attempt-failed` notice clears on the next try.
      Progress after an accepted install comes from `host.status.updateProgress`,
      not from the install response, because the swap is detached and outlives
      it.
  - **Installation** reads `host.getInstallationInfo`. `unmanaged` is a real
    state, not an error - a host run from a checkout has no install record - and
    it says so rather than claiming nothing is installed.
  - **Doctor** (`host-doctor-rpc-card.tsx`) has the host shell its own CLI. Two
    things make the report trustworthy over a connection, and both come from the
    host: the structured failure arms (`cli-unavailable` / `cli-failed` /
    `invalid-output` are ANSWERS - only a transport failure is an error, a 500
    means transport and nothing else), and the **transport vantage**. The host
    reports which issue codes its own vantage already disproves; over a local
    WebSocket `SERVICE_STOPPED` / `PORT_UNREACHABLE` / `PORT_CONFLICT` describe
    the listener that just answered us, so they move into a collapsed "checks
    this connection already answers" section and out of the count. Over a relay
    that set is EMPTY on purpose - a relay proves the relay, not the daemon's
    loopback listener - so the same code stays a real issue for a remote host.
    Fix routing: `host-restart`/`host-start` → `host.restart`, `host-logs` →
    `diagnostics.logs.tail` (tail rendered inline); `service-install`,
    `free-port-and-restart` and `host-install-latest` stay local-only and degrade
    to the copy-command affordance for a remote host. That is not a missing RPC:
    they repair a host that is typically not answering RPCs at all, so remote
    verbs for them were dropped from the plan on purpose.
  - **Danger zone** (`host-scope/host-danger-zone.tsx`), three planes, each
    gating itself: File edit snapshots (host RPC, behind the scope gate), Remove
    Traycer (local CLI bridge, local host only, never gated on reachability), and
    **Remove from account** (an account write, remote + registered only). That
    last one is NEVER called "deregister" in copy - this app already uses that
    word for OS-SERVICE deregistration in the Advanced disclosure one card away,
    and two destructive controls sharing a verb is how someone reaches for the
    wrong one. Its confirmation is written against what the route actually does:
    `POST /api/v3/hosts/:id/deregister` stamps `deregisteredAt` and clears the
    presence lease, does NOT revoke, and keeps the `hostId` - so nothing is
    uninstalled and no data is deleted. What it does NOT do was got wrong here
    once, in the reassuring direction: a running host does NOT re-enrol itself.
    Its next heartbeat 404s and it reads that as `not-registered`, but
    `reconcile()` then finds the on-box device credential still present and
    still matching, takes `adoptActiveCredential()` and RETURNS - before either
    enrollment source, and `registerHost()` is the only caller that clears
    `deregisteredAt`. So it loops instead of recovering, and signing in again on
    that machine does not help either, because the interactive login path sits
    below that same early return. The dialog states both negatives explicitly,
    and the test pins the refuted claim as ABSENT - a dialog that quietly
    promises self-recovery is worse than one that says nothing, since it is the
    reason someone would leave a host removed and expect it back. The
    deregistered-host re-enrollment gap itself is a recorded product follow-up,
    not a client-side fix.

  **The recovery console is GONE.** `host-recovery-console.tsx` was what
  remained of the old CLI-bridge page and the last `IHostManagement` consumer
  here; it rendered for THIS COMPUTER only, and only when there was no host
  process to ask. Folding host settings into the Overview removed it along with
  the `emptyAccountLocalRecovery` carve-out, so Settings no longer has a
  bridge-backed surface at all and every pane on this page describes its host by
  asking that host. Getting a machine that has no host process back into a
  usable state is the host-readiness gate's job, upstream of Settings — the gate
  a person passes before they can reach this page, with the window narrator
  explaining the wait.
  - The legacy `/settings/service` redirect (so any bookmark, remembered tab
    path, or tray command lands on this same pane) is unchanged. Shells without
    the Traycer CLI (web, mobile) never got a reduced page and still do not:
    with the console gone, every shell renders the same RPC Overview.

- **Diagnostics is TWO panels**, split 2026-08-14. Both render a **Log detail**
  `SettingsGroup` and a **Recent logs** viewer that may use the remaining height
  - a design pass (`settings-related-panels-core-flows` artifact) separated
    capture controls from the evidence viewer and added a reset reminder.

  The split is about REPETITION, not about per-row honesty. The single page was
  deliberately mixed-scope and said so per row: `App log level`, the heap
  capture and this window's own log tail described the app, while `CLI log
level`, `Host log level` and the host's log tails described the selected host.
  Each row was accurate. But the app half does not vary by host, so an account
  with four hosts drew four copies of it - four `App log level` selects and four
  `Capture heap snapshot` buttons writing the same single value, under four
  different host names. The rule the groups encode ("if it varies by host it
  sits under the picker") already said where the app half belonged.

  What did NOT split is the presentation. `diagnostics-log-entries.tsx` holds
  the frame, the tail view and the bridge-backed entry; `LogDetailGroup`
  (`diagnostics-log-detail-group.tsx`) renders whatever `LogLevelControl[]` its
  caller passes, so both pages get identical rows and one **Reset all to Info**
  sweep. With no controls AND a `null` empty state it renders nothing at all -
  that null case is what keeps the host page from titling an empty "Log detail"
  card when the logs region below is already stating the host's version. Note it
  is a `ReactNode` VALUE: passing `<HostLogDetailEmptyReason />` would be truthy
  however it rendered, so the reason is a function the panel calls.

- `Diagnostics` (Application, `app-diagnostics-settings-panel.tsx`) The app's
  own `App log level` row, the **Memory** heap capture, and the **Desktop Log**
  entry. Takes no host scope, mounts no `HostScopeGate`, and stands up no
  `HostClient` - if any of that becomes necessary to render it, something
  host-varying has moved back on. Its two bridges are independent
  (`platform.logLevels` and `platform.diagnostics`), so each states its own
  unavailability and a shell missing one still gets the other.

- `Diagnostics` (Host, `diagnostics-settings-panel.tsx`) `CLI log level`,
  `Host log level` and that host's own log files, over its
  `config.logLevels.*` / `diagnostics.logs.*` RPCs. Each row arrives as a
  `LogLevelControl` with its transport already resolved
  (`log-level-controls.ts`), so `LogLevelRow` stays presentational and the sweep
  walks RPC and bridge rows without knowing which is which.
  - **Log detail.** Two rows (`LogLevelRow`, a `Select` over the full
    `trace/debug/info/warn/error` scale, `info` labelled "Info (default)") - all
    default Info and apply immediately. The CLI/host thresholds are
    machine-user-global (`~/.traycer/cli/config.json`), which the row copy says:
    they apply to every Traycer host environment on that machine, not to one
    host instance. When any level differs from Info, the group grows a further
    row: a quiet reminder plus a **Reset all to Info** button that resets only
    the non-default scopes (any level different from Info, not just Warn/Error -
    Trace/Debug count too; sequentially, not in parallel).
  - **Recent logs · Last N lines**: the card is content-sized while its entries
    are collapsed, grows only as rows/expanded output require, and caps at the
    remaining panel height; only then does it become the page's primary scroll
    region. An expanded entry's tail text gets its own small bounded/internal
    scroll instead of growing the list. Per entry: expand/collapse, **Copy**
    (only once expanded), and one path action. That action is **Reveal** for a
    bridge-owned file and **Copy path** for a host-owned one:
    `shell.showItemInFolder` opens a path on THIS machine, so it is meaningless
    for a remote host - and even locally it would resolve the path itself rather
    than the one the host just named, which is a different file the moment two
    host slots share a machine. The list is the scoped host's own logs from
    `diagnostics.logs.list`; this app's log used to lead it and now lives once,
    on the Application page. On the local-bridge fallback path the snapshot
    still carries `desktop` alongside `host` (the bridge answers one question
    for both pages), so this page filters it out and the app page takes it.
    `diagnostics.logs.tail`
    answers a discriminated union, so a file that vanished between list and tail
    reads "This log file is no longer there." rather than an empty tail.
    Both failures - a tail read and the top-level list load - show inline error
    text plus a report-issue action. They were asymmetric until 2026-08-12,
    which made the panel harder to report from the worse the failure was: one
    log that would not open could be filed, while the read that lists every log
    failing left the user with text and nothing to do.
  - **Each unavailable state stays inside the group it affects**, and each page
    now says the thing that is actually true of it. The old shared empty copy
    ("Log level controls are only available on the desktop app") was a claim
    about the SHELL, and after the split it would have been the host page's only
    empty state - telling someone whose host is merely too old to install an app
    they are already running. The app page keeps that copy, because there it is
    the real reason; the host page states the host's version instead, or renders
    no card when the logs region is already stating it. A zero-log response is
    likewise explicit ("No log files on &lt;host&gt;.") rather than an empty card.
- `Usage` (`usage-settings-panel.tsx`, in the **Account** group beside
  Sessions - see "Scope: the organising idea" above for why it is not under
  the host picker. Groups must stay contiguous in `settings-sections.ts`, so
  landing it there pushed Shell past `SINGLE_DIGIT_LEADER_INDEX_LIMIT` into the
  digit-less tail. Adding Application -> Diagnostics later pushed **Agent
  selection** out too, which runs against the rule that support surfaces are the
  ones to lose digits - it is forced by position, since an Application entry
  lands in the first four whatever it is. See that file's own note). All reading
  `host.usage.summary` through `UsageSummaryPanel`
  (`components/usage-analytics/`), placement-agnostic. `host.usage.summary`
  is an OPTIONAL RPC (`degrade: { kind: "unsupported" }` in the protocol
  registry), so this section stays in the static list either way and instead
  swaps its BODY for a capability notice (same anatomy as `HostScopeGate`'s
  internal notices - an idle host-capability gap, not an error) on a host
  that predates the capability. Every priced figure carries its own asterisk
  plus a five-word footnote below it, "* if billed at full API rate"
  (`describeCostHeadline` in `cost-format.ts`) - the ONE standing exception is
  a "· N turns not counted" suffix while unpriced turns exist. Everything
  else - the estimate-at-list-prices framing, that a subscription bills
  separately, the exact-vs-estimate split with amounts, the not-counted
  detail - lives in a tooltip on the figure (`usageCostTooltip`), never as
  standing text (fixup-01, user ruling 2026-08-10: match t3code's density;
  the words "provenance"/"modeled"/"unpriced" never appear in UI - the wire
  still carries the full split for the tooltip). `servedBy: "local"` states
  the this-machine-only scope; a cloud-unavailable read renders a retryable
  error card rather than silently falling back to local-looking data (the
  host resolver's cloud-unavailable path is a plain `RPC_ERROR` on this
  transport, so `isTransientHostRpcFailure` cannot classify it - the card
  offers Retry unconditionally instead).
  - **Ticket 11 dashboard build-out (t3code shape).** Window picker
    (7/30/90 days) + a date-range label beside it + cost/token toggle;
    per-harness cost split under the headline (share bar, % of cost, token
    total - colors keyed off the same series scale as the chart's legend);
    a per-day stacked chart (harness breakdown, custom SVG/CSS per the
    `dataviz` skill) whose legend chips now double as a series FILTER
    (`applyUsageSeriesVisibility` zeroes a hidden series' segments without
    reassigning colors - "color follows the entity, never its rank"); a
    5-tile stat row (processed tokens, cached input, uncached input, output,
    cache savings - `usage-stat-tiles.ts` owns every "absent, not zero"
    computation, e.g. reasoning tokens/cache-savings multiple render only
    when the known sum is actually positive); and a Model/Day toggle on the
    harness/model breakdown table (`buildUsageDayBreakdownRows` folds the
    same buckets by day instead). A window-wide note ("Excludes N turns with
    no usage reported") appears under the stat tiles whenever
    `usageCompletenessBreakdown.absent > 0` - those turns still contribute
    silent zeros to every token sum, which would otherwise misread as "no
    caching happened" rather than "nothing was reported". Fixup-01 (below)
    removed the standing cost-quality panel and the breakdown tables'
    Provenance column entirely - neither is a "layout" element this bullet
    still describes.
  - **Ticket 12 removed the ambient epic-canvas cost badge** (this panel's
    former `UsageSummaryPanel` reuse target,
    `epic-canvas/panels/epic-cost-badge.tsx`) per the user ruling that no
    dollar figure belongs ambient anywhere. The epic canvas status row now
    carries a numberless `EpicUsageEntryPoint` instead, opening
    `EpicUsageDialog` (headline, small trend chart, by-chat/agent breakdown,
    window options including "entire epic") on click - see that panel's own
    doc comments, not this file, since it is not a Settings surface.
  - **Ticket 13 made this ONE cross-host dashboard, not a per-host page.**
    The cloud plane was already per-user and cross-host (its reader filters by
    user + time); what was missing was the host DIMENSION, not another view.
    So `host.usage.summary` gained an optional `hostId` filter and a
    `hostBuckets` grouping alongside `chatBuckets`, and the page gained:
    - a **host filter defaulting to "All hosts"** (`usage-host-filter.tsx`).
      On `servedBy: "local"` it is not a disabled dropdown but a plain
      readout naming this machine - that plane can only ever see the machine
      it runs on, so there is nothing to choose BETWEEN, and a greyed-out
      picker would say "you may not choose" instead. A foreign `hostId`
      against the local plane returns an EMPTY summary, never an error,
      mirroring the zero-rows shape a foreign `epicId`/`chatId` already has.
    - a **by-host breakdown** (`usage-host-split.tsx`), shown only once there
      is more than one host, with the same column anatomy as the harness
      split. Deliberately NOT keyed to the daily chart's series scale: that
      scale colors harnesses, and reusing it would paint a host and a harness
      the same hue in one view.
    - **names joined client-side** from `useHostScope().hosts` (the merged
      directory + registry model - see "One host model"). No host name rides
      the wire: a name is directory state that changes without the fact
      changing, and only the client knows a host it can no longer reach. An
      id nothing can name renders as a TRUNCATED ID, never a blank cell.
    - **scope copy that follows the filter** - `servedByScopeNote` now takes
      the picked host's name and qualifies the headline whenever the figure
      covers less than the account.
  - **Fixup-01 (tickets 11/12) rewrote cost presentation to t3code's density**
    (user ruling 2026-08-10, three rounds, final - superseded the ticket 11
    "priced subtotal + N unpriced turns" phrasing and deleted ticket 11's
    cost-quality panel and both breakdown tables' Provenance column, plus
    ticket 12's equivalents in the scoped dialogs). `UsageCostFigure`
    (`components/usage-analytics/usage-cost-figure.tsx`) stays the single
    owner of the presentation across the dashboard AND both ticket-12 scoped
    dialogs (epic + chat) - see that file's own doc comment for the current
    rule, not this one, so the rule can't fragment across two descriptions.

The default editor (`defaultEditor` in the settings store) has no dedicated
panel - the Open split button on the Epic header doubles as its picker: clicking
an editor in its dropdown sets it as the default and persists across reloads.

## Current Status

The settings surface is a real local settings shell; every row is wired into
runtime behavior. The previously-inert Language, Speed, Show in menu bar, and
Default workspace mode rows were removed.

## Maintenance Note

- keep this file focused on structure, ownership, and linkage status
- keep inline comments in settings source files pointing back here
- when adding or removing sections, update both this file and
  `settings-sections.ts`
