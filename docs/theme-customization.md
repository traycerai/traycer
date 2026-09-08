# Theme customization: reference research and parity contract

The reference is the locally cloned T3 Code repository at
`/home/anurag/code/reference/t3code` at commit
`0d34579d674920cc47fc5c908494f51ed3895204`, inspected September 2026. The requested
outcome is equivalent appearance customization in Traycer, including the
appearance page, floating editor, inspector, and theme-pack import. A simpler
theme picker alone does not satisfy that contract.

## Reference architecture

T3 has a typed palette registry, a CSS semantic-token bridge, independent
appearance preferences, and an editor mounted above its router. It also still
has large implementation files: its `themePalette.ts` contains persistence,
validation, color math, and DOM application, and its `index.css` still contains
built-in theme selectors. Traycer should borrow the functional boundaries
without reproducing those monolithic files.

All reference paths in this document are relative to the T3 checkout.

| Concern                | Reference source                                          | Behavior                                                                                |
| ---------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Palette contract       | `packages/shared/src/themePalettes.ts:47`                 | 57 named semantic color roles; base light/dark appearance and optional opposite variant |
| Runtime registry       | `apps/web/src/themePalette.ts`                            | Built-ins, local custom library, and environment themes                                 |
| Color parsing          | `apps/web/src/themePalette.ts:486`                        | Culori literal color parsing and canonical OKLCH output                                 |
| Guided palette         | `apps/web/src/themePalette.ts:792`                        | Derives surfaces and readable text from canvas and accent                               |
| Persistence            | `apps/web/src/themePalette.ts:1257`                       | Validated CRUD, collection replacement, storage failures                                |
| DOM application        | `apps/web/src/themePalette.ts:1551`                       | One role-to-variable mapping; root inline properties                                    |
| CSS bridge             | `apps/web/src/index.css:1132`                             | Palette roles map to existing shadcn/component variables                                |
| Appearance resolution  | `apps/web/src/hooks/useTheme.ts`                          | Palette, appearance mode, independent light/dark selections, OS changes                 |
| Before-React boot      | `apps/web/index.html`                                     | Reads saved appearance and colors before mounting to avoid a flash                      |
| Appearance route       | `apps/web/src/components/settings/SettingsPanels.tsx`     | Theme library, opacity, typography, contrast, motion                                    |
| Theme library UI       | `apps/web/src/components/settings/ThemeSettings.tsx`      | Wireframe mode previews, spherical swatches, collection variants, management            |
| Global editor session  | `apps/web/src/components/settings/themeEditorStore.ts`    | Editing/seed IDs, initial appearance, distinct session identity                         |
| Global editor mount    | `apps/web/src/components/settings/ThemeEditorHost.tsx`    | Above router, lazy loaded, survives navigation                                          |
| Editor                 | `apps/web/src/components/settings/ThemeEditorPanel.tsx`   | Guided/advanced editing, live preview, drag, resize, minimize, save/cancel              |
| Inspector              | `apps/web/src/components/settings/themeInspector.ts`      | Computed CSS dependency probing and SVG highlights                                      |
| Local import           | `apps/web/src/components/settings/ThemeImportDialog.tsx`  | JSON, files, drag/drop, duplicate handling, batch import                                |
| VS Code adapter        | `apps/web/src/vscodeThemeImport.ts`                       | Workbench colors mapped into application roles                                          |
| Open VSX adapter       | `apps/web/src/openVsxThemes.ts`                           | Search, download, checksum, bounded VSIX parsing, includes                              |
| Search UI              | `apps/web/src/components/settings/ThemeSearchSection.tsx` | Debounce, popular queries, sorting, cancellation, install/update                        |
| Fonts                  | `apps/web/src/appearanceFonts.ts`                         | Interface, composer, code font variables, font discovery and sizing                     |
| Terminal integration   | `apps/web/src/components/ThreadTerminalDrawer.tsx:865`    | Observes root changes and reapplies colors during previews                              |
| Optional server themes | `apps/server/src/environmentTheme.ts`                     | Watches published files and streams theme updates                                       |

### Definition, preference, and draft are separate

A reference theme has a stable ID, label, appearance, complete color record,
optional opposite appearance, and optional collection identity. Export wraps it
in a versioned JSON envelope. T3 stores its custom library under
`t3code:themes:v1`; themes are local to the device/browser.

The active palette ID does not encode the appearance preference. Light, dark,
and system are independent, and optional per-mode theme IDs allow a light
palette from one family and a dark palette from another. A single-mode theme
never pretends to provide its missing appearance. Removed themes and stale
selections fall back predictably.

An editor draft must never be persisted by its keystrokes. It paints the real
application while the editor remains open across navigation. Cancel, close,
and unmount restore the persisted selection. Save validates and writes before
reporting success. Storage quota/unavailability leaves the draft open. Editing
an imported theme must preserve its syntax payload unless deliberately reset.

The reference preserves unrecognized stored entries during ordinary writes and
refuses to overwrite a completely unreadable library. Collection updates
compare the collection captured before downloading with the current library
before replacing it. Cross-window storage events invalidate cached snapshots.

### CSS and subsystem integration

T3 writes `--app-theme-*` variables on `<html>` and uses one CSS bridge to map
them to existing `--background`, `--card`, `--popover`, `--primary`, sidebar,
and terminal variables. Components continue using semantic classes. The
appearance mode also updates `.dark`, browser chrome, `theme-color` metadata,
and Electron native appearance.

The application must have one source of palette truth. CSS selectors for each
theme, hand-maintained terminal color tables, and independent code-theme
switches otherwise drift. JavaScript consumers such as terminal renderers
must observe draft palette changes, not only saved preferences. Syntax themes
must reach both block highlighting and diff rendering where supported.

The before-mount theme boot matters: applying the right theme only in a React
effect still flashes the default theme. The reference has a dedicated boot
test to prevent divergence between startup and runtime resolution.

### Floating editor and inspection

The editor is a nonmodal dialog. It does not trap focus or block navigation.
Its header can be dragged, its corner resized, and its body minimized. The
header and close/cancel controls remain recoverable after viewport resizing.
Traycer additionally needs safe-area-aware viewport bounds and readable editor
chrome even when a draft makes application foreground/background identical.

Guided mode chooses background and accent and derives the palette. Advanced
mode provides grouped color roles with filtering, text values, and a picker.
Invalid partial values do not blank the live app. Both light/dark edits must
survive toggling and save together atomically when editing a pair.

T3's inspector first tries semantic utility-class matches. Robust discovery
then reads computed paint values, temporarily changes a token to a sentinel,
reads computed values again, and restores the token synchronously before a
paint. This discovers dependencies through aliases and `color-mix()`, unlike
merely comparing equal color values. It disables transitions during probing
and restores prior inline priorities. Selecting a role highlights its users;
selecting an app element reveals its role in the editor. Inspection intercepts
the underlying action, supports Escape, and excludes its own controls.

Whole-document dependency scans have a cost proportional to mounted elements
and probed tokens. Do not perform that operation on every pointer move. DOM
inspection cannot identify the individual paints inside a canvas terminal;
the terminal surface still needs ordinary editable tokens. Highlight geometry
must refresh on scrolling/resizing and discard disconnected elements.

## What VS Code compatibility actually means

T3's implementation is best-effort workbench palette import, not an extension
runtime. It requires `editor.background`, infers appearance when unspecified,
flattens alpha onto destination surfaces, derives missing roles, and only
accepts specified foregrounds when they remain readable on those surfaces.
It pairs unambiguous names differing by Light/Dark and resolves duplicate
labels using filenames and suffixes. Pack identity is separate from display
names.

The reference does **not** apply TextMate `tokenColors`, semantic tokens, ANSI
terminal palettes, icon themes, executable extensions, or every VS Code color
key. Syntax-only packages without an editor background fail. T3's local file
path uses `JSON.parse`, although its package path supports JSONC comments and
trailing commas. Traycer should not repeat those limitations accidentally or
claim universal extension support. Its compatibility copy must distinguish
color themes from arbitrary extensions and explain unsupported formats.

Open VSX search and import are browser-side in T3, with no server RPC. It uses
JSZip, jsonc-parser, and SHA-256 hashing. Search gets registry details and
manifests, filters supported open-source licenses, checks package sizes, and
shows eight usable results. Installation reads the package's own manifest,
resolves theme contributions/includes, verifies identity, and replaces the
collection as one operation. No JavaScript from the extension is executed.

### Untrusted package boundaries

Retain explicit limits and verification:

- HTTPS registry URLs; validate downloads against the intended registry.
- SHA-256 integrity and packaged publisher/name/version consistency.
- License metadata consistency and clear source attribution.
- Capped streaming downloads rather than trusting Content-Length.
- Bounded archive entries, total expanded size, compression ratios, manifest
  size, theme count, per-theme size, and include depth/count.
- Path normalization that rejects absolute paths, traversal, and NULs.
- Include-cycle detection, JSONC validation, and literal color validation.
- Abort stale searches and installs; time out network requests.
- No extraction of executable files and no activation of extension code.
- Collection replacement remains atomic if one contributed theme fails.

T3 uses 20 MiB download, 100 MiB expanded, 5,000 entries, ratio 200, 256 KiB
per JSON file, 40 contributed themes, and include depth 8. These are reference
limits, not a requirement that every constant be identical in Traycer.

## Traycer implementation

All implementation paths below are relative to `clients/gui-app/src/`.

| Responsibility                                                     | Owner                                                                             |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Typed semantic roles, literal-color validation, guided derivation  | `lib/themes/theme-definition.ts`                                                  |
| All 17 built-in families, both appearances                         | `lib/themes/builtin-palettes.ts`                                                  |
| Durable local library, independent selections, transient draft     | `stores/settings/theme-library-store.ts`                                          |
| Synchronous startup/runtime application and revision notifications | `lib/theme-applier.ts`                                                            |
| Sidebar, glass, prompt typography, motion and artwork bridge       | `styles/theme-surfaces.css`                                                       |
| Visual appearance selector and collection management               | `components/settings/themes/theme-gallery.tsx`                                    |
| Lazy global floating editor and dependency inspector               | `components/settings/themes/theme-editor-{host,panel}.tsx`, `theme-inspector.tsx` |
| Prompt typography, ligatures, contrast and panel motion            | `components/settings/themes/appearance-details.tsx`                               |
| Native/VS Code JSONC, local VSIX, includes and palette conversion  | `lib/themes/theme-import.ts`                                                      |
| Open VSX search, extension IDs, verified downloads                 | `lib/themes/open-vsx.ts`                                                          |
| Search/import preview, explicit update/copy, stale-update guard    | `components/settings/themes/theme-import-dialog.tsx`                              |
| Shared consumer refresh signal                                     | `providers/use-theme-revision.ts`                                                 |
| Imported TextMate registration                                     | `lib/themes/syntax-theme.ts`                                                      |

The existing appearance panel keeps Traycer's interface, code, terminal,
artifact, and desktop zoom settings. The new gallery replaces the old preset
rows. Palette data replaces the theme-name branches in `index.css` and the
retired `terminal-themes.css`; layout, safe-area, and typography rules stay in
CSS. Existing saved preset IDs continue to resolve. The migration preserves
the original cascade, including light preset overrides inherited by dark
variants.

One synchronous applier writes registered root variables before subscribers
render. CSS consumers update automatically; terminals, terminal hints,
Mermaid, streaming/block Shiki highlighting, and Pierre diffs subscribe to the
same revision. Imported TextMate rules reach Shiki and Pierre. CodeMirror
continues using its existing Lezer syntax highlighting and semantic surface
tokens; VS Code semantic-token rules and executable extensions are not run.

The library is local to the browser profile. It validates and writes storage
before changing saved state, refuses to overwrite an unreadable library, and
refreshes library selections/preferences on cross-window storage events.
Drafts stay in memory. The original settings store still owns the
System/Light/Dark preference and existing font settings.

Imports accept Traycer exports, VS Code color-theme JSON/JSONC, and VSIX files.
Open VSX supports search and exact `publisher.extension` IDs. Downloaded packs
are pinned to a version, SHA-256 checked, and matched to their packaged
publisher/name/version. Imports extract theme data without executing extension
code. Workbench mapping is necessarily best effort: applications have different
surfaces and not every VS Code role has a Traycer equivalent.

### Verification performed

- GUI `bun run compile` passed; ESLint passed for every changed/new TypeScript
  file.
- 27 focused tests passed across six suites: theme parsing/VSIX includes,
  inspector restoration, synchronous application, durable storage, appearance
  grouping, and the real gallery/editor create-edit-pair-save-cancel flow.
- A migration comparison verified **1,564 exact palette values across 34
  variants** against the original CSS cascade.
- Live registry downloads imported official Dracula (2 variants), Catppuccin
  (4), Nord (1), and Tokyo Night (3), including their TextMate rules.
- React Doctor reported no errors and three manual-memoization warnings.
  Those memos retain synchronous CSS snapshots and diff cache identities.
- The stylesheet compiled through Vite. A complete browser session was not
  available: the UI tool reported “No browser is available.” Desktop/mobile
  visual review and real terminal/diff interaction remain unverified. The
  isolated preview also encountered unrelated shared-workspace import aliases,
  so its HTTP responses are not evidence of a complete app smoke test.

The checklist below is retained for interactive acceptance. Checked items have
automated or live-service evidence; unchecked items require a real browser or
desktop session even where their implementation is present.

## Functional parity acceptance checklist

This is the acceptance contract, not a claim of completed visual review.

- [ ] Appearance page uses visual System/Light/Dark previews and clear selection.
- [ ] Built-in, custom, and imported themes have palette-derived visual swatches.
- [ ] Independent light/dark theme selections follow OS changes in system mode.
- [ ] A theme pack groups its variants with understandable names and selections.
- [ ] Create, duplicate, rename/edit, export, and remove work from the library.
- [ ] Removing an active theme restores a valid selection for each appearance.
- [ ] Floating editor survives navigation and previews the entire app.
- [ ] Editor drags, resizes, minimizes, remains viewport/safe-area bounded, and is keyboard usable.
- [ ] Neutral editor controls remain readable under extreme contrast previews.
- [ ] Guided background/accent generation produces readable companion colors.
- [ ] Advanced grouped roles support filtering, color picker, and literal text input.
- [ ] Invalid partial color input preserves the last valid live preview.
- [x] Light/dark draft edits survive toggling and save atomically.
- [ ] Save errors preserve the draft; cancel/close restore all app/code/terminal colors.
- [ ] Inspect selects actual token dependencies and reveals the matching field.
- [ ] Selected colors highlight their usage; inspection does not activate underlying controls.
- [ ] JSON paste, local JSON/JSONC files, drag/drop, and multi-file import work.
- [ ] Duplicate imports offer explicit replace/copy rather than silent overwrites.
- [ ] Open VSX search supports popular queries, sorting, loading, empty/error states, and cancellation.
- [ ] Theme pack install/update supports includes and all compatible contributions atomically.
- [x] Local VSIX import and extension IDs are supported if advertised in the UI.
- [ ] Imported workbench colors reach app chrome, sidebar, controls, messages, and terminals.
- [ ] Imported ANSI and syntax payloads reach the corresponding consumers where advertised.
- [ ] Glass opacity visibly changes intended menus/dialogs/composer surfaces and has reset.
- [ ] Typography offers interface, prompt, code, and terminal font families and sizes.
- [ ] Typography advanced options, resets, font discovery/fallbacks, and ligatures are handled.
- [ ] Contrast controls and panel-animation duration have real runtime effects and reset.
- [ ] Reduced-motion preferences remain authoritative.
- [ ] Initial boot has no incorrect palette flash; browser/Electron chrome follows appearance.
- [ ] Themes persist across restart and synchronize between browser windows.
- [ ] Malformed/quota-limited storage does not erase existing data or falsely report success.
- [x] Built-in palette colors live in modular data, with no theme-name CSS branches.
- [ ] Package security, parsing, theme resolution, preview rollback, and inspector checks pass.
- [ ] Desktop and mobile-width visual review covers default and high-contrast custom palettes.

Environment-identification copy in the reference identifies T3 Dev/Nightly
builds; adapt it to Traycer's actual release-channel affordances. T3's optional
server-published themes and CLI defaults are a separate capability outside the
attached appearance screenshots; they should be explicitly scoped if desired.

## Reference verification and source reuse

Relevant T3 tests include `themePalette.test.ts`, `themeBoot.test.ts`,
`hooks/useTheme.test.ts`, `themeEditorStore.test.ts`, `ThemeEditorHost.test.tsx`,
`themeInspector.test.ts`, `ThemeImportDialog.test.ts`, `vscodeThemeImport.test.ts`,
`openVsxThemes.test.ts`, `appearanceFonts.test.ts`, and
`appearanceContrast.test.ts`.

The reference repository's `LICENSE` is MIT, copyright T3 Tools Inc. 2026.
Substantial copied/adapted implementation must retain that notice. This work
uses the reference to understand behavior and implements against Traycer's
existing React, Zustand, Tailwind, color, and component infrastructure.

## External format documentation

- [VS Code color-theme guide](https://code.visualstudio.com/api/extension-guides/color-theme)
- [VS Code workbench color reference](https://code.visualstudio.com/api/references/theme-color)
- [Open VSX registry API](https://github.com/eclipse-openvsx/openvsx/wiki/Registry-API)
