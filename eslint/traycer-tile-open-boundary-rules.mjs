/**
 * Ban raw link egress and raw tile-open wrappers; both must go through `useOpenLink` / `useEpicTileNavigation().openTile`.
 * Nested-focus still bans the store actions under `prepare*`; this file bans the wrappers. Complements, not alternatives.
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
   * The access shapes a banned name can take.
   * `key.name` is the extracted property, never a renamed local, so `{ x: openExternalLink }` is correctly not flagged.
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

export const LINK_EGRESS_BRIDGE_RESTRICTIONS = [
  ...nameAccessRestrictions("openExternalLink", LINK_ACCESS_MESSAGE),
  ...nameImportRestrictions("openExternalLink", LINK_IMPORT_MESSAGE),
];

export const LINK_EGRESS_HOOK_RESTRICTIONS = nameImportRestrictions(
  "useOpenExternalLink",
  LINK_HOOK_IMPORT_MESSAGE,
);

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

export const LINK_EGRESS_RESTRICTIONS = [
  ...LINK_EGRESS_BRIDGE_RESTRICTIONS,
  ...LINK_EGRESS_HOOK_RESTRICTIONS,
  ...LINK_EGRESS_DOM_RESTRICTIONS,
];

/**
 * Every `prepare*FocusTarget` that opens or places a tile (C1).
 * Three of these now exist only in their `...FromSource` form, which the regex below covers either way - the bare names stay so a revival is banned on sight.
 */
const TILE_OPEN_PREPARE_ACTION_NAMES = [
  "prepareOpenTileInTabFocusTarget",
  "prepareOpenTilePreviewInTabFocusTarget",
  "prepareOpenTileInBackgroundTabFocusTarget",
  "prepareOpenTileInPaneFocusTarget",
  "prepareSplitPaneWithNodeFocusTarget",
];

const DELETED_TILE_NAVIGATION_METHOD_NAMES = [
  "openTileInEpic",
  "openTilePreviewInEpic",
  "openTilePreviewInTab",
];

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
