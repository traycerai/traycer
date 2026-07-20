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
  host-scoped file edit snapshot storage management, and data migration. The
  snapshot row has its own host selector and clear confirmation names the
  selected host; picking there uses a transient client and does not rebind the
  app-wide active host.
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
  - **Terminal cursor
    (`controls/terminal-cursor-style-picker.tsx` + a `Switch`).** Two rows below
    the terminal font. `Terminal cursor` is a segmented shape picker (iTerm2
    style - each option draws the actual glyph, block centered) backed by
    `terminalCursorStyle` (`"block" | "bar" | "underline"`, default `block`);
    `Blink cursor` is a `Switch` backed by `terminalCursorBlink` (default on).
    Both are captured in the host's `initialOptionsRef` for first paint and
    live-synced into `term.options` via `useTerminalAppearanceSync`. On blur the
    cursor stops blinking (xterm's inactive cursor never blinks) and
    `cursorInactiveStyle` mirrors the chosen shape via `inactiveCursorStyleFor`,
    except `block` falls back to a hollow `outline` so an unfocused pane stays
    visually distinct. The
    `Terminal preview` row reflects the chosen shape/blink with a CSS-only
    cursor so the effect is visible without an xterm instance.
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
    disabling it hides the Traycer harness from the new-chat picker and blocks
    runs like any other provider.
- `Notifications` Host-side notification generation controls. The `In-app`
  column gates durable host-row creation before anything enters the bell feed,
  unread count, tab indicators, delivery channels, or notification hooks.
  Collaboration and app-local notifications are independent. Notification
  hooks are configured separately below the grid and further filter generated
  rows by severity.
  Backed by `host.notifications.getConfig` /
  `host.notifications.setConfig` through host-scoped TanStack Query hooks.
  The protocol still carries forward-compatible email config, but this panel
  round-trips it untouched instead of exposing an inactive email delivery
  surface.
- `Agents` Editor for the **global** agent selection guide
  (`~/.traycer/agent-selection-guide.md`) - the instructions Traycer agents read
  to decide which child agents to spawn (harness / model / reasoning effort) for
  a task. A full-height CodeMirror Markdown source editor provides syntax
  highlighting and line numbers, including for Mermaid and wireframe fences.
  It debounce-auto-saves (and flushes on blur) via
  `agent.selectionGuide.setGlobal`; a quiet "Saving… / Saved" status sits in the
  footer, no Save button. A **Revert to default** button (disabled while the
  content already equals the provider-based default) calls
  `agent.selectionGuide.resetGlobalToDefault` behind a `ConfirmDestructiveDialog`.
  The editor has its own host selector; it reaches non-active hosts with a
  transient `useHostClientFor` context override and remounts when that local
  selection changes so one device's file never carries into another. Backed by
  `agent.selectionGuide.getGlobal` (returns `{ content, generatedDefaultContent }`),
  `agent.selectionGuide.setGlobal`, and
  `agent.selectionGuide.resetGlobalToDefault` through the agent selection guide
  hooks. Settings only edits the global scope; the panel hint points users at
  per-workspace `.traycer/agent-selection-guide.md` files, which layer on top of
  the global guide (see the agent selection guide hierarchy in the host).
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
  - **UI (Direction B - live-preview cards).** Two cards under
    `panels/shell/`: a _Shell_ card with an `EffectiveCommandPreview`
    (terminal-styled `❯ <path> <args>`, reusing `--term-ansi-*`), a
    `ShellProgramCombobox`, and `ShellFlagChips` (labelled _Startup flags for
    &lt;shell&gt;_, with the "`-i -l` loads your full shell profile" helper only
    when the selected program is a login shell, and a quiet _Restore default
    flags_ action shown only while the visible flags deviate from the family
    default - reverting the SELECTED shell via
    `useRunnerTraycerShellRevertArgsMutation`); and an _Environment variables_
    card with the shared inline `EnvOverrideEditor` (host-process scope only -
    set/unset mode, value edit, key rename, and staged add/remove; per-harness
    env now lives in Settings → Providers). Existing env rows **auto-save on
    commit** (env blur/Enter); new env rows apply only when their check button
    is pressed. Other controls auto-save on commit (row select, add, chip
    add/remove) and a quiet "Saving… / ✓ Saved" status sits in each card. The
    footer holds only that save status - there is no reset button.
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
- `Worktrees` Host-wide management of the git worktrees Traycer creates under
  `~/.traycer/worktrees/`, presented as a calm inspection-and-cleanup list, not
  a delete console. A host selector (default = active host, gated on
  `useHostReachability`, demoted to quiet toolbar chrome rather than a
  dominant control) drives a disk-truth list - so orphaned worktrees whose
  owning chat/agent was deleted still appear - grouped by repo under quiet,
  collapsible headers (`WorktreeRepoHeader`) that stay visually secondary to
  row status. The selected host is reached through a **transient per-host
  client** (`useHostClientFor`) so picking a host never swaps the app-wide
  active host or reloads the Epic list. Backed by the host
  `worktree.listAllForHost` / `worktree.deleteByPath` RPCs through
  `useHostQuery` / `useHostMutation`. Setup/teardown script editing is NOT
  here - the create-worktree flow owns it, and scripts otherwise live in the
  committed `.traycer/environment.json`.
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
    cleanup. **In use** means an active chat or agent references it - both
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
- `Host` Cross-device **My Hosts** plus a clearly labeled **This machine**
  local lifecycle-management section for the native-packaging flow. Local rows
  act only on the host service running on this machine. Three top-level rows -
  **Status** (running / stopped / not-installed, with
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
