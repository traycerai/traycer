# Theme customization

Traycer supports independent light/dark selections, a local theme library, live
editing and inspection, and VS Code/Open VSX color-theme imports.

## Traycer implementation

All implementation paths below are relative to `clients/gui-app/src/`.

`styles/theme-surfaces.css` applies the same glass opacity to shared menus,
submenus, popovers, hover cards, dialogs and drawers, plus custom composer and
editor floating surfaces. Each surface paints one glass layer; embedded command
lists inherit a transparent background, while standalone command lists retain
their normal fill. Fixed menu headers and footers remain transparent. Sticky
rows retain their fill to cover scrolling content, and compact inverted tooltips
and theme-editor recovery controls retain their dedicated styling.

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

In production, `styles/theme-fallback.css` supplies a neutral palette before
the module bundle evaluates. It follows the system color scheme where
`light-dark()` is supported and otherwise starts with light colors. In
development, Vite injects the stylesheet during module evaluation. Inline tokens then
restore the saved theme. Regenerate this fallback after changing base colors
with `bun scripts/generate-theme-fallback.ts` from `clients/gui-app`.

The library is local to the browser profile. It validates and writes storage
before changing saved state, refuses to overwrite an unreadable library during
ordinary edits, and refreshes library selections/preferences on cross-window
storage events. A damaged library exposes an explicit reset with a deletion
confirmation; failed reset writes preserve the existing data.
Drafts stay in memory. The original settings store still owns the
System/Light/Dark preference and existing font settings.

Imports accept Traycer exports, VS Code color-theme JSON/JSONC, and VSIX files.
Open VSX supports search and exact `publisher.extension` IDs. Downloaded packs
are pinned to a version, SHA-256 checked, and matched to their packaged
publisher/name/version. Imports extract theme data without executing extension
code. Workbench mapping is necessarily best effort: applications have different
surfaces and not every VS Code role has a Traycer equivalent.

### Appearance interface

The appearance page shows compact mode controls and two selected-theme rows.
Each row opens a searchable picker with the 17 built-in families and saved
themes for that appearance. Only the current selections occupy the page;
small three-color swatches replace the preview and repeated palette cards.
A separate saved-theme manager retains selection, editing, duplication,
individual and full-pack export, filtering, and deletion.

The floating editor uses independent graphite and sage colors so recovery
controls remain readable during extreme theme edits. Palette / All colors
controls expose guided derivation and individual tokens in compact horizontal
color rows; inspection, drag, resize, minimize, paired editing, save, and
rollback remain available. During editing, system modals release their focus,
pointer, and scroll locks so the floating editor can interact with the app,
including when switching from Settings to History.
Normal modality returns on save/cancel. Radix remounts the Settings content
when modality changes, so transient disclosure/scroll state may reset.

Import sources have separate Browse themes and Import files tabs. Community
results use full-width rows; local files have a drop area and expandable JSON
input. A shared review area preserves staged imports when switching tabs and
retains explicit update/copy choices and stale-update protection.

The compact components pass GUI type checking, scoped Oxlint/ESLint, and
React Doctor with no diagnostics. Thirteen focused appearance/editor checks
pass, including independent picker selection, all 17 built-in choices,
manager-to-editor focus, and paired-save/source-pack safety. The prior JSON
import test covers staging, switching tabs, cancellation, and saving.
A real Settings-modal integration test also verifies editor focus, pointer
lock release during editing, and restoration on cancel.
Vite/Tailwind stylesheet transformation includes the picker viewport cap and
compact editor layout. Interactive visual acceptance is still pending: no
browser is available through the UI tools.

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

## External format documentation

- [VS Code color-theme guide](https://code.visualstudio.com/api/extension-guides/color-theme)
- [VS Code workbench color reference](https://code.visualstudio.com/api/references/theme-color)
- [Open VSX registry API](https://github.com/eclipse-openvsx/openvsx/wiki/Registry-API)
