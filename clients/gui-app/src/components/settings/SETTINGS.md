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
        ├── AgentsSettingsPanel
        ├── KeybindingsSettingsPanel
        ├── ShellSettingsPanel
        ├── WorktreesSettingsPanel
        └── HostSettingsPanel
```

Settings is also presented as a **modal** via `settings-modal-content.tsx`,
which maps each `SettingsSectionId` to its panel in a `switch`. A new section
must be added in BOTH places - the route file under `src/routes/` AND the modal
`switch` - or the modal renders a blank pane for that section.

## Key Files

- `settings-layout.tsx` Owns the two-column shell for the settings route.
- `settings-sidebar.tsx` Renders navigation from `settings-sections.ts`.
- `settings-panel-shell.tsx` Shared width, card shell, and panel spacing.
- `panels/*.tsx` Route-mounted settings sections.
- `controls/settings-select.tsx` Shared select wrapper used by settings rows.
- `src/stores/settings-store.ts` Persisted local settings state.

## Sections

- `General` App-level preferences: chat turn-completion notifications, prevent
  sleep while running, pin context usage breakdown (global toggle for the
  always-visible chat context-window breakdown, default off), voice input,
  local snapshot storage management, and data migration.
- `Appearance` Theme, global artifact icon color mode, type-color customization,
  and typography controls.
  - **Typography.** Three structurally identical rows - `UI font`, `Code font`,
    and `Terminal font` - each pair a font picker with its size input stacked
    directly below (the terminal row uses the nullable size input). Keeping the
    terminal family + size in one row (rather than two) removes the stray
    divider that used to split a single conceptual group. Backing state lives in
    `settings-store.ts`:
    `uiFontFamily` / `codeFontFamily` / `terminalFontFamily` (`string | null`)
    and `terminalFontSize` (`number | null`) - `null` means "use the default"
    (UI: Figtree, Code: the system mono stack) or, for the two terminal
    fields, "follow the Code font/size". `uiFontSize` is clamped 10-20 (it
    scales the root font-size and breaks layout above that); `codeFontSize`
    and `terminalFontSize` are clamped 10-24. `theme-provider.tsx` applies
    `uiFontFamily`/`codeFontFamily` as inline overrides of
    `--traycer-font-ui`/`--traycer-font-mono` (chosen font + the default
    stack as fallback), removing the override when `null`. The terminal host
    (`terminal-tile-xterm.tsx`) resolves its own effective font
    (`terminalFontFamily ?? codeFontFamily`) and size
    (`terminalFontSize ?? codeFontSize`) directly from the store rather than
    reading computed CSS, and live-syncs both into `term.options` (see
    `resolveEffectiveFontFamily` and `useTerminalAppearanceSync`). The
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
  `useHostQuery` / `useHostScopedMutation`. A header host picker (shown
  only with more than one host) scopes the whole pane to the selected host
  by re-providing the runtime client for the panel subtree (transient
  `useHostClientFor`, the Worktrees pattern); the default is the active
  host. Selection + custom paths + enabled flag + per-provider env persist
  host-side in `~/.traycer/host/config/provider-overrides.json` (per-device
  == per-host). Disabling a provider marks it unavailable in the new-chat
  picker. `providers.list` is cached for 15 min
  (no auto-refetch on remount/focus) to avoid re-running `--version` probes; a
  header refresh icon (`RefreshIconButton` → `useRefreshProviders`)
  force-refreshes the list and harness availability on demand.
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
  - **Terminal agent arguments.** A `TerminalAgentArgsSection` text input (saved
    on blur/Enter) captures extra CLI args spliced into the spawned argv when the
    provider is launched as a terminal agent. The field re-syncs to the saved
    value if it changes underneath (refetch / another window) and stays editable
    while a save is in flight (writes are serialized host-side). Shown only for
    terminal-agent-capable providers - it checks `useGuiHarnessesQuery` for the
    mapped harness (`HARNESS_ICON_ID`) advertising the `tui` `mode`, so it's
    hidden for Cursor. Persisted as `terminalAgentArgs` in
    `provider-overrides.json` via `providers.setTerminalAgentArgs`
    (`useProvidersSetTerminalAgentArgs`, invalidates only `providers.list`). In
    `agent.tui.prepareLaunch` the host tokenizes the string and each harness
    adapter splices it where its CLI parses it as top-level flags (appended for
    Claude/OpenCode, but BEFORE Codex's `resume` subcommand). The launch picker
    pre-fills this value as a cosmetic default; an untouched pre-fill launches
    with `null` so the host resolves the current saved value itself.
  - **API-key providers (Cursor).** Cursor authenticates with an API key rather
    than a CLI login, so its row renders an `ApiKeySection` (masked input +
    Save/Clear) when `state.apiKey.supported`, plus a "Create an API key" link
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
    `useProvidersClearApiKey`). Cursor is GUI-only in the UI for now - its
    `cursor-agent` TUI surface is hidden until the CLI reaches feature parity
    (the adapter advertises only the `gui` mode via `listGuiHarnesses`'s
    `modes`) - so the Cursor row hides the CLI candidates table and shows only
    the API-key section; the key drives the `@cursor/sdk` GUI chat surface.
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
    disabling it hides the Traycer harness from the new-chat picker and blocks
    runs like any other provider.
- `Agents` Editor for the **global** agent selection guide
  (`~/.traycer/agent-selection-guide.md`) - the instructions Traycer agents read
  to decide which child agents to spawn (harness / model / reasoning effort) for
  a task. A monospace `Textarea` debounce-auto-saves (and flushes on blur) via
  `agent.selectionGuide.setGlobal`; a quiet "Saving… / Saved" status sits in the
  footer, no Save button. A **Revert to default** button (disabled while the
  content already equals the provider-based default) calls
  `agent.selectionGuide.resetGlobalToDefault` behind a `ConfirmDestructiveDialog`.
  Default-host scope: the editor remounts (keyed on the active host id) so a host
  swap reseeds from that device's file. Backed by `agent.selectionGuide.getGlobal`
  (returns `{ content, generatedDefaultContent }`), `agent.selectionGuide.setGlobal`,
  and `agent.selectionGuide.resetGlobalToDefault` through the agent selection
  guide hooks. Settings only edits the global scope; the panel hint points users
  at per-workspace `.traycer/agent-selection-guide.md` files, which layer on top
  of the global guide (see the agent selection guide hierarchy in the host).
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
  `IRunnerHost.traycerCli`. Hidden on shells without a CLI (mobile, web).
  - **UI (Direction B - live-preview cards).** Two cards under
    `panels/shell/`: a _Shell_ card with an `EffectiveCommandPreview`
    (terminal-styled `❯ <path> <args>`, reusing `--term-ansi-*`), a
    `ShellProgramCombobox` (editable path input + detected-shell quick-picks),
    and `ShellFlagChips`; and an _Environment variables_ card with the shared
    inline `EnvOverrideEditor` (host-process scope only - set/unset mode, value
    edit, key rename, and staged add/remove; per-harness env now lives in
    Settings → Providers). Existing env rows **auto-save on commit** (env
    blur/Enter); new env rows apply only when their check button is pressed.
    Other controls auto-save on commit (combobox select/Enter, chip add/remove)
    and a quiet "Saving… / ✓ Saved" status sits in each card.
    Reset is a low-emphasis footer button, disabled while `synthesised`.
  - **Detected shells** come from `traycer config shell list` →
    `protocol/config` `detectShells()` (POSIX `/etc/shells` + probe set +
    `$SHELL`, `X_OK`-filtered; Windows probes PowerShell/cmd), surfaced via
    `ITraycerCli.shellListDetected()` and the `useRunnerTraycerShellListQuery`
    hook (cached for the session). Best-effort - an empty list is fine since the
    combobox always accepts a typed custom path. Env **rename** is
    client-sequenced (`envOverrideSet` new → `envOverrideDelete` old) with an
    inline unique-key + `/^[A-Za-z_][A-Za-z0-9_]*$/` guard.
- `Worktrees` Host-wide management of the git worktrees Traycer creates under
  `~/.traycer/worktrees/`. A host selector (default = active host, gated on
  `useHostReachability`) drives a disk-truth list - so orphaned worktrees
  whose owning chat/agent was deleted still appear - grouped by repo and showing
  branch, path, an **In use** badge, an **Orphaned** badge (no resolvable main
  repo), and an uncommitted-change count. The selected host is reached through
  a **transient per-host client** (`useHostClientFor`) so picking a host
  never swaps the app-wide active host or reloads the Epic list. Backed by the
  host `worktree.listAllForHost` / `worktree.deleteByPath` RPCs through
  `useHostQuery` / `useHostMutation`. Delete is disabled for in-use rows
  (server-rejected as a backstop) and requires an extra confirm that names the
  change count when the worktree is dirty; orphan dirs git no longer tracks fall
  back to an `fs.rm` cleanup host-side. Setup/teardown script editing is NOT
  here - the create-worktree flow owns it, and scripts otherwise live in the
  committed `.traycer/environment.json`.
- `Host` The active host-management surface for the native-packaging flow.
  Three top-level rows - **Status** (running / stopped / not-installed, with
  version + listen URL + pid), **Actions** (Restart, or Install host when
  not-installed; plus Run doctor which opens a side `Sheet` mounting
  `HostDoctorCard`), and **Updates** (Update / Check now / Retry depending on
  `registryCheck` state). Two collapsed disclosures sit below: _Installation
  details_ (version, source, install date, verification, SHA-256, platform -
  stacked single-column so it stays readable at narrow widths) and _Advanced_
  (OS service register / deregister · "Pick a different version" expander
  showing the available versions list). Status derives from
  the live `LocalHostSnapshot` stream (`runnerHost.onLocalHostChange`)
  combined with the cached `installedRecord()` - running iff a snapshot exists,
  stopped iff installed but no snapshot, not-installed otherwise.
  `IServiceHost.status()` is deliberately not consulted (it's wedged on some
  shells). The available versions list inside _Advanced_ surfaces the real
  registry error message (from `registryState.errorMessage` or the
  `availableVersions()` rejection) with a Retry button rather than the generic
  "Couldn't reach the registry" copy. Backed by the CLI-backed
  `hostManagement` runner-host facet. Hidden on shells without the Traycer
  CLI. The legacy `/settings/service` route now redirects here so any bookmark,
  remembered tab path, or tray command lands on the same pane as the primary
  sidebar entry.

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
