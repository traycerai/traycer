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
        └── DiagnosticsSettingsPanel
```

Settings is also presented as a **modal** via `settings-modal-content.tsx`,
which maps each `SettingsSectionId` to its panel in a `switch`. A new section
must be added in BOTH places - the route file under `src/routes/` AND the modal
`switch` - or the modal renders a blank pane for that section.

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

- **Application** - General, Appearance, Keybindings.
- **Account** - Sessions.
- **Host** - headed by THE host picker (`host-scope/host-switcher.tsx`).
  Everything under it - Overview, Providers, Worktrees, Notifications, Agent
  selection, Shell, Diagnostics - is scoped by that one selection.

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

`requiresLocalHost` (Shell, Diagnostics) marks a TRANSPORT limit, never a scope
one: shell config and `hostLogLevel` are fields of the selected host's own
config, but this client reads them through the local CLI bridge. Those sections
stay in the host group and render `RequiresLocalHostNotice` for a remote host,
rather than showing this computer's values under another host's name. An
earlier pass let the missing RPC exile them into the App group, which put the
surface right back to "memorise the exceptions".

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
  `useReactiveActiveHostId`) - which host this window talks to for ambient
  work: notification indicators, the bell, rate limits, the resource monitor,
  and where newly started work lands. Changed ONLY by a labelled verb that
  states its consequence ("Use this host in this window"), never as a
  dropdown side effect. Always wears the accent.

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
  **rendered**. It guards its CHILDREN and nothing else - a control passed as a
  sibling prop (`headerAction`) is outside it, which is how Providers' Refresh
  button once re-probed the ambient host while the page named another.
- `isHostScopeUsable(status)` decides what is **mounted**. A query hook under a
  non-usable scope still fires and caches its answer no matter what the gate
  renders, so panels that own host reads check this before mounting them.

Every section in the `host` group mounts the gate. Shell and Diagnostics wrap
their host-tied bodies in it whole (Diagnostics keeps its app-scoped rows -
the desktop log level and the memory capture - outside, since their subject
never changes with the scope). Overview is the exception that proves the rule:
most of its body never touches the scoped host's RPC - the local service
console runs over the CLI bridge and is the RECOVERY surface, and the Updates
card writes through the account API - so it mounts the whole-panel gate only
for the unresolved and `vanished` cases, renders its body for `connecting` and
`unreachable`, and the RPC-backed rows gate themselves inside
`HostDangerZone`. The reason is the same one that motivates the gate: a `null`
scoped host that defaulted to "local" once put this computer's service console
under a host that no longer exists.

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
two a person can act on; for the local machine the live service snapshot
outranks the cloud lease. It DELEGATES to `deriveHostPresence`
(`panels/my-hosts-model.ts`) rather than re-deriving it - that function's
invariants (no green dot without live evidence; live-session evidence outranks
the lease; an expired lease under degraded presence reads "unknown", never a
false "Offline") are tested and load-bearing.

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
    never named. Their arm-time target capture lives there too. The zone's
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
    provider header and its config.** Order is `general` · `account` · `usage` ·
    `env` · `mcp` · `plugins` · `skills`, filtered per provider through
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
      `useReactiveActiveHostId()` for the re-render. Settings can target a
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
  Backed by the `traycer config shell` / `traycer config env` CLI through
  `IRunnerHost.traycerCli`. On shells without a CLI (mobile, web) the panel
  says so rather than hiding; on a remote scoped host it renders
  `RequiresLocalHostNotice`, and on an unresolved scope it renders the gate -
  never this computer's values under another host's name.
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
    default - reverting the SELECTED shell via
    `useRunnerTraycerShellRevertArgsMutation`). **On Windows hosts with WSL
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
      clears ONLY the selection via `useRunnerTraycerShellConfigResetMutation`
      (invalidates just the config query). Remembered shells and their flags are
      kept - the login shell's own entry is inherited - so the row stays checked
      even when the login shell has customised flags, and editing the flags row
      while checked persists to that entry without un-checking it.
    - **The concrete list** is `detectShells()` ∪ the user's `shell.entries`
      paths (`traycer config shell list` → `ITraycerCli.shellListDetected()` →
      `useRunnerTraycerShellListQuery`, cached for the session), sorted purely
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
      driven by a debounced native probe (`ITraycerCli.shellProbe` →
      `useRunnerTraycerShellProbeQuery`): non-absolute → "an absolute path is
      required"; found+executable → green "✓ found · executable"; the amber
      states ("found, but not executable" / "not found on this machine") **block
      the add**. Enter adds only from the green state (remember + select via
      `ITraycerCli.shellConfigAdd` → `useRunnerTraycerShellConfigAddMutation`,
      which invalidates both the config and list queries). A **Browse…** row
      (`ITraycerCli.pickShellProgramFile`, hidden when the dialog capability is
      absent) runs a chosen file through the same probe gate - executable files
      are added outright, a non-executable pick is left in the input with its
      amber status. The ✕ removes via `ITraycerCli.shellConfigRemove` →
      `useRunnerTraycerShellConfigRemoveMutation`; the backend falls back to the
      OS default when the removed shell was current.
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
- `Host` **Overview**: one page about ONE host - the scoped one. The
  cross-device **My Hosts** list and the separate **This machine** section are
  both gone; the sidebar switcher is the collection, and every lifecycle verb
  lives on the Overview of the host it describes. A self-identifying **summary
  card** (`host-settings-summary-card.tsx`) leads, then a single **Updates**
  card holding BOTH mechanisms (the local controller's check/apply via
  `HostUpdateRegion`, and the account registry's auto-update policy,
  version pin and drain-gate force via `host-scope/host-registry-updates.tsx`),
  then **Installation**, then the **Danger zone**. This replaced the old three
  top-level rows (Status / Actions / Updates, `host-settings-status-row.tsx` /
  `-actions-row.tsx` / `-updates-row.tsx`, all deleted); status derivation and
  the CLI-backed `hostManagement` facet underneath are unchanged.
  `HostRegistryUpdates` is keyed by `hostId` and its controls capture their
  target when armed, so a scope change cannot re-point an open confirmation.
  - **Summary card.** One bordered card holding, top to bottom: an optional
    install/restart/update progress banner and a terminal-outcome banner
    (retry/dismiss) so in-flight or failed operations render inside the card
    instead of as unrelated page-level alerts; an identity row (display name,
    status dot + label, and a `v{version} · {listenUrl} · pid {pid}` meta line
    built from whichever parts are non-null: version shows whenever a host is
    installed (both `running` and `stopped`, from the live snapshot or the
    installed record respectively), while `listenUrl`/`pid` are `running`-only
    - so a stopped host still shows its installed version, just without a
      listen URL or pid); a contextual actions cluster;
      and, as a compact bottom strip of the same card, the update region.
      Status still derives from the live `LocalHostSnapshot` stream
      (`runnerHost.onLocalHostChange`) combined with the cached
      `installedRecord()` - running iff a snapshot exists, stopped iff installed
      but no snapshot, not-installed otherwise; `IServiceHost.status()` is still
      deliberately not consulted (wedged on some shells).
  - **Contextual actions** (`HostSummaryActions`): not-installed shows only a
    primary **Install host**; otherwise a **Restart** button appears - primary
    when stopped, secondary once running - alongside an always-present
    secondary **Run doctor** (opens a side `Sheet` mounting `HostDoctorCard`)
    and a ghost **Edit name** toggle. Install and Restart are mutually
    exclusive as the leading button; only Restart's emphasis (not its
    presence) changes between stopped and running.
  - **Edit name** is a focused inline-edit state (toggled by "Edit name", not
    open by default): an `Input` plus **Cancel**, **Reset** (disabled with no
    custom name set), and **Save** (disabled until the trimmed draft actually
    differs) - a successful Save or Reset both close the editor back to the
    summary view.
  - **Update region**, the card's bottom strip, hidden entirely when not-
    installed: a ready staged version shows a version label + primary
    **Update** button; otherwise a download in progress shows a spinner +
    percent; otherwise an unreachable registry shows **Retry**; otherwise a
    green "Up to date" plus a ghost **Check now** (tooltip shows last-checked
    time). The action button gates on `updateReady`/a resolved staged
    version, never the raw "an update was merely detected" signal, so this
    region never offers an action for a not-yet-ready update.
  - **Installation** (`SettingsGroup`, two disclosures, both collapsed by
    default): _Installation details_ (version, source, install date,
    verification, SHA-256, platform - stacked single-column so it stays
    readable at narrow widths) and _Advanced_ (OS service register/deregister
    · release-candidate-inclusion checkbox · "Pick a different version"
    expander showing the available versions list, version pin/rollback). The
    available versions list surfaces the real registry error message (from
    `registryState.errorMessage` or the `availableVersions()` rejection) with
    its own Retry, independent of the update region's Retry above - the two
    error/retry paths are separate and can both be live at once.
  - Busy-host force/defer confirmation, the restart confirmation dialog, and
    the legacy `/settings/service` redirect (so any bookmark, remembered tab
    path, or tray command lands on this same pane) are all unchanged. Hidden
    on shells without the Traycer CLI.
- `Diagnostics` A **Log detail** `SettingsGroup` followed by a **Recent logs**
  viewer that may use the remaining height - a design pass
  (`settings-related-panels-core-flows` artifact) separated capture controls
  from the evidence viewer and added a reset reminder; the underlying
  RPCs/log-tail mechanics are unchanged.
  - **Log detail.** Three rows - `App log level`, `CLI log level`, `Host log
level` (`LogLevelRow`, a `Select` over the full `trace/debug/info/warn/
error` scale, `info` labelled "Info (default)") - all default Info and
    apply immediately. When any level differs from Info, the group grows a
    fourth row: a quiet reminder plus a **Reset all to Info** button that
    resets only the non-default scopes (any level different from Info, not
    just Warn/Error - Trace/Debug count too; sequentially, not in parallel).
  - **Recent logs · Last N lines** (`DiagnosticsLogs`): the card is content-
    sized while its entries are collapsed, grows only as rows/expanded output
    require, and caps at the remaining panel height; only then does it become
    the page's primary scroll region. An expanded entry's tail text gets its
    own small bounded/internal scroll instead of growing the list. Per entry:
    expand/collapse, **Reveal** (open on disk, always visible), and **Copy**
    (only once expanded). A tail-read failure shows inline error text plus a
    report-issue action; the top-level list-load failure shows inline error
    text with **no** report-issue action - a real asymmetry, not by design.
  - **Two independent desktop-support gates, each contained to its own
    group.** `LogDetailGroup` checks `getLogLevelsBridge()` and
    `RecentLogsSection` separately checks `resolveDesktopSupportBridge()` -
    neither gates the panel as a whole, and neither disappears when its own
    bridge is missing. Each renders its OWN group/card with an inline "only
    available on the desktop app" message in place of its controls, so a shell
    where the two bridges disagree still shows both group labels, with
    whichever one lacks its bridge explaining why instead of vanishing or
    silently going blank. A has-bridge-but-zero-logs response similarly gets
    an explicit "No log files found." message in the Recent logs card rather
    than rendering empty.

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
