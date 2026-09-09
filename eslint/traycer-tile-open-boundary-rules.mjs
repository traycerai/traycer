/**
 * Two seams from the tile-opening refactor (`specs/tile-opening-refactor`,
 * decisions A6 and C1), expressed the same way
 * `traycer-nested-focus-boundary-rules.mjs` expresses its own: exported
 * `no-restricted-syntax` selector arrays, esquery only, composed into
 * `gui-app/eslint.config.mjs` so the oxlint JS plugin picks them up through
 * `adaptOxlintConfig` and both linters enforce the identical set.
 *
 * 1. LINK EGRESS (A6). Every URL leaves the app through
 *    `useOpenLink()(url, kind, event)`, which is the only place the
 *    in-app/external setting, the modifier rules (A3) and the failure toast
 *    (A5) exist. A raw `openExternalLink`, a `window.open` or a JSX
 *    `target="_blank"` is a second door that answers to none of them - the
 *    defect this refactor existed to remove was ~40 such doors.
 *
 * 2. TILE OPEN (C1). A tile enters a canvas through
 *    `useEpicTileNavigation().openTile(intent)` (or `openTileWithNavigation`
 *    for the non-React callers), which runs the placement settings, the
 *    grouping and dedupe rules and the analytics source through one resolver.
 *    The `prepare*FocusTarget` actions underneath are that resolver's private
 *    vocabulary: calling one directly re-hard-codes a placement, which is
 *    exactly the per-tile-kind divergence P4 describes.
 *
 * The nested-focus dimension keeps banning the RAW store actions underneath
 * the `prepare*` wrappers; this file bans the wrappers. They are complements,
 * not alternatives - a file exempt from one is not exempt from the other.
 *
 * KNOWN LIMITS (deliberate, same reasoning as the nested-focus file - a
 * broader selector would flag unrelated code, and value-flow tracking is not
 * expressible in esquery):
 *
 * - Alias flow escapes both sets: `const open = host.openExternalLink;
 *   open(url)` matches on the member access itself, but
 *   `const { ...rest } = host; rest.openExternalLink(url)` does not, and
 *   neither does a `prepare*` handle passed through a variable declared
 *   somewhere else.
 * - A `window.open` / `globalThis.open` CALL is banned by name. A destructured
 *   or aliased one (`const { open } = window; open(url)`) is not: a bare
 *   `open(` callee selector would flag every unrelated local named `open`
 *   (dialogs, popovers, disclosure state), which is most of them.
 * - The deleted-method half bans only `openTileInEpic`,
 *   `openTilePreviewInEpic` and `openTilePreviewInTab`. `openTileInTab` -
 *   the fourth deleted `useEpicTileNavigation` method - is deliberately
 *   ABSENT: it is also a live `EpicCanvasStore` action name that the
 *   nested-focus dimension already governs (with two reasoned per-file
 *   allowances), so banning it here would either double-report the store
 *   access or contradict those allowances. Distinguishing
 *   `tileNavigation.openTileInTab` from `store.openTileInTab` needs to know
 *   what the object IS, which esquery cannot decide. The three names above
 *   are unambiguous, and a resurrected `openTileInTab` on the navigation hook
 *   would not type-check anyway - `EpicTileNavigation` exposes `openTile`
 *   and nothing else.
 */

const LINK_ACCESS_MESSAGE =
  "Do not reach `openExternalLink` directly. Call `useOpenLink()(url, kind, event)` from `@/lib/links/open-link` and pick the `LinkKind` for this surface (markdown | terminal | github | image are user-configurable; auth | docs | account | app are always external) so the setting, the modifier rules and the failure toast all apply.";
const LINK_IMPORT_MESSAGE =
  "Do not import `openExternalLink` outside the link layer. Call `useOpenLink()(url, kind, event)` from `@/lib/links/open-link` and pick the `LinkKind` for this surface.";
const LINK_HOOK_IMPORT_MESSAGE =
  "Do not import `useOpenExternalLink` outside `src/lib/links/`. It IS the bridge, so a component holding it bypasses the in-app/external setting, the modifier rules and the failure toast. Call `useOpenLink()(url, kind, event)` from `@/lib/links/open-link` instead.";
const WINDOW_OPEN_MESSAGE =
  "`window.open` / `globalThis.open` is a no-op in the Electron renderer and bypasses the in-app/external setting. Call `useOpenLink()(url, kind, event)` from `@/lib/links/open-link` and pick the `LinkKind` for this surface.";
const TARGET_BLANK_MESSAGE =
  'Do not open a link with `target="_blank"` - it bypasses the in-app/external setting and lands in an unmanaged browser. Give the anchor an onClick that calls `useOpenLink()(url, kind, event)` from `@/lib/links/open-link`, and pick the `LinkKind` for this surface.';

const TILE_PREPARE_MESSAGE =
  "Do not call a canvas `prepare*FocusTarget` action directly - that hard-codes one placement for one tile kind. Use `useEpicTileNavigation().openTile(intent)` (or `openTileWithNavigation` outside a component) so placement settings, grouping, dedupe, the route write and the analytics source all come from the one resolver.";
const TILE_DELETED_METHOD_MESSAGE =
  "`openTileInEpic` / `openTilePreviewInEpic` / `openTilePreviewInTab` are gone from `useEpicTileNavigation`. Use `useEpicTileNavigation().openTile(intent)` and express the difference in the intent (`target`, `gesture`, `modifiers`).";

/**
 * The access shapes a banned NAME can take. Mirrors the `tabActivate` block in
 * `traycer-nested-focus-boundary-rules.mjs` - dot member, string-computed
 * member, template-computed member (a no-substitution template is NOT a
 * `Literal` node), and any `ObjectPattern` property in all three key forms,
 * which covers declaration, assignment and parameter destructuring at once.
 * `key.name` is the EXTRACTED property, never a renamed local, so
 * `{ x: openExternalLink }` is correctly not flagged.
 */
function nameAccessRestrictions(namePattern, accessMessage) {
  return [
    {
      selector: `MemberExpression[computed=false][property.name=/^(${namePattern})$/]`,
      message: accessMessage,
    },
    {
      selector: `MemberExpression[computed=true][property.type='Literal'][property.value=/^(${namePattern})$/]`,
      message: accessMessage,
    },
    {
      selector: `MemberExpression[computed=true][property.type='TemplateLiteral'][property.quasis.0.value.cooked=/^(${namePattern})$/]`,
      message: accessMessage,
    },
    {
      selector: `ObjectPattern > Property[key.type='Identifier'][key.name=/^(${namePattern})$/]`,
      message: accessMessage,
    },
    {
      selector: `ObjectPattern > Property[key.type='Literal'][key.value=/^(${namePattern})$/]`,
      message: accessMessage,
    },
    {
      selector: `ObjectPattern > Property[key.type='TemplateLiteral'][key.quasis.0.value.cooked=/^(${namePattern})$/]`,
      message: accessMessage,
    },
  ];
}

function nameImportRestrictions(namePattern, importMessage) {
  return [
    {
      // import { openExternalLink } / import { openExternalLink as x }.
      selector: `ImportSpecifier[imported.type='Identifier'][imported.name=/^(${namePattern})$/]`,
      message: importMessage,
    },
    {
      // Quoted named import: import { "openExternalLink" as x }. `imported` is
      // a Literal here, so the selector above misses it.
      selector: `ImportSpecifier[imported.type='Literal'][imported.value=/^(${namePattern})$/]`,
      message: importMessage,
    },
  ];
}

/**
 * A6, bridge half. Exempt (in `gui-app/eslint.config.mjs`):
 * `src/lib/links/open-external-link.ts` (the bridge itself),
 * `src/lib/auth/auth-service.ts` (device-grant and provider-reauth URLs, which
 * are hard-external by A2 and run outside React), and test files.
 */
export const LINK_EGRESS_BRIDGE_RESTRICTIONS = [
  ...nameAccessRestrictions("openExternalLink", LINK_ACCESS_MESSAGE),
  ...nameImportRestrictions("openExternalLink", LINK_IMPORT_MESSAGE),
];

/**
 * A6, hook half. The bridge hook is banned by IMPORT rather than by access,
 * because its own two consumers below the seam (`open-link.ts`,
 * `open-browser-url.ts`) are exactly the files the config exempts - and
 * `useOpenExternalLink` is a hook, so an import is the only way to hold one.
 * Its own module defines it and imports nothing, so it needs no exemption.
 */
export const LINK_EGRESS_HOOK_RESTRICTIONS = nameImportRestrictions(
  "useOpenExternalLink",
  LINK_HOOK_IMPORT_MESSAGE,
);

/**
 * The other half of A6, split out because TESTS are exempt from the bridge
 * half above and NOT from this one. A test legitimately stubs the runner-host
 * bridge (`{ openExternalLink: vi.fn() }`) and asserts on that stub - the
 * property name is the observation, the same reason `selectById` is lifted in
 * the test block. `window.open` and `target="_blank"` have no such reading:
 * they are doors, not doubles, and a test that opens one is asserting the app
 * has a door it is not allowed to have.
 */
export const LINK_EGRESS_DOM_RESTRICTIONS = [
  {
    selector:
      "CallExpression[callee.object.name=/^(window|globalThis|self)$/][callee.property.name='open']",
    message: WINDOW_OPEN_MESSAGE,
  },
  {
    // <a target="_blank">
    selector: "JSXAttribute[name.name='target'][value.value='_blank']",
    message: TARGET_BLANK_MESSAGE,
  },
  {
    // <a target={"_blank"}> - the value is a JSXExpressionContainer, so the
    // `value.value` selector above does not see the string.
    selector:
      "JSXAttribute[name.name='target'] > JSXExpressionContainer > Literal[value='_blank']",
    message: TARGET_BLANK_MESSAGE,
  },
];

/** Both halves, for the config's `generalCustomSyntaxRestrictions`. */
export const LINK_EGRESS_RESTRICTIONS = [
  ...LINK_EGRESS_BRIDGE_RESTRICTIONS,
  ...LINK_EGRESS_HOOK_RESTRICTIONS,
  ...LINK_EGRESS_DOM_RESTRICTIONS,
];

/**
 * Every `prepare*FocusTarget` that opens or places a tile (C1). Three of these
 * now exist only in their `...FromSource` form, which the regex below covers
 * either way - the bare names stay so a revival is banned on sight.
 */
const TILE_OPEN_PREPARE_ACTION_NAMES = [
  "prepareOpenTileInTabFocusTarget",
  "prepareOpenTilePreviewInTabFocusTarget",
  "prepareOpenTileInBackgroundTabFocusTarget",
  "prepareOpenTileInPaneFocusTarget",
  "prepareSplitPaneWithNodeFocusTarget",
];

/** The `useEpicTileNavigation` methods C1 deleted, minus the ambiguous one. */
const DELETED_TILE_NAVIGATION_METHOD_NAMES = [
  "openTileInEpic",
  "openTilePreviewInEpic",
  "openTilePreviewInTab",
];

/**
 * C1. Exempt (in `gui-app/eslint.config.mjs`): the resolver/executor itself
 * (`src/lib/canvas/tile-open/*`), its hook (`use-epic-tile-navigation.ts`),
 * the store that DEFINES these actions, and the two reasoned below-the-seam
 * callers named there. Tests are exempt too - they stub store shapes.
 */
export const TILE_OPEN_RESTRICTIONS = [
  ...nameAccessRestrictions(
    // `...FromSource` is the same action carrying an analytics source.
    `(${TILE_OPEN_PREPARE_ACTION_NAMES.join("|")})(FromSource)?`,
    TILE_PREPARE_MESSAGE,
  ),
  ...nameAccessRestrictions(
    DELETED_TILE_NAVIGATION_METHOD_NAMES.join("|"),
    TILE_DELETED_METHOD_MESSAGE,
  ),
];
