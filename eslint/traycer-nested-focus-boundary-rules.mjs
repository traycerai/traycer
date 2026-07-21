/**
 * Bans raw, focus-mutating `useEpicCanvasStore` action access from outside
 * the nested-focus-opener boundary (`useEpicTileNavigation` /
 * `useEpicNestedFocusNavigation` -> `prepare...FocusTarget` +
 * `navigateNested`). Calling one of these actions directly mutates the
 * canvas but never writes the TanStack route search params
 * (`focusPaneId` / `focusTileInstanceId`) that back/forward navigation and
 * reload rely on - the desync this rule exists to prevent shipped six times.
 *
 * Every action here has a `prepare<Name>FocusTarget` counterpart on
 * `EpicCanvasStore` (see `src/stores/epics/canvas/store.ts`) that performs
 * the same mutation AND returns the resulting `NestedFocusTarget` for the
 * boundary to commit to the route. Calling the raw action instead of its
 * `prepare*` counterpart is exactly the bypass this rule bans.
 *
 * Covered access shapes are direct selector picks (including selectors wrapped
 * by helpers such as `useShallow`), block-bodied selector returns, direct
 * `getState().action()` calls (dot and literal-computed access), and object
 * destructuring directly from `getState()`. Alias flow such as
 * `const state = useEpicCanvasStore.getState(); state.closeCanvasTab()` is not
 * expressible soundly with esquery alone because it requires scope/value-flow
 * tracking; keep that as a known limit rather than adding a broad selector
 * that would flag unrelated variables. The inverse limit also holds: inside a
 * block-bodied selector, a `return x.action` in a locally-declared nested
 * function still matches (the ReturnStatement is a descendant of the anchored
 * arrow) - a false positive accepted deliberately, since tightening to
 * top-level returns would miss real conditional returns of a banned action.
 *
 * Deliberately EXCLUDED (verified against store.ts/actions.ts, not just the
 * initial audit brief):
 * - `promotePreviewInTab`: its reducer (`promotePreview`) only clears
 *   `previewTabId`; it never touches `activeTabId`/`activePaneId` and has no
 *   `prepare*FocusTarget` counterpart at all, so it never needs a route
 *   write. Called directly today from `epic-sidebar-artifact-tree.tsx`,
 *   `epic-sidebar-chat-tree.tsx`, `tab-group-view.tsx`, and
 *   `root-dnd-provider.tsx`.
 * - `resizeSplitInTab`: `prepareResizeSplitFocusTarget` always returns
 *   `null` (pure layout, never focus) and is called directly from
 *   `tile-canvas.tsx` today.
 * - `openTileInNewTab` / `tearOffTabIntoNewHeaderTab`: header-tab creation,
 *   not nested-tile focus - no `prepare*FocusTarget` counterpart exists.
 * - `openTile` (the bare reducer in `actions.ts`): not exposed on the store
 *   instance/interface at all, so it is unreachable via either AST form
 *   below.
 */

export const NESTED_FOCUS_BOUNDARY_ACTION_NAMES = [
  "openTileInTab",
  "openTilePreviewInTab",
  "openTileInBackgroundTab",
  "openTileInPane",
  "openBlankTabInPane",
  "setActiveTileTab",
  "setActiveTilePane",
  "insertNodeOnTabStrip",
  "moveTabOnTabStrip",
  "splitPaneWithNode",
  "splitPaneWithTab",
  "splitPaneEmptyInTab",
  "splitPaneEmptyRightInTab",
  "closeCanvasTab",
  "closeOtherCanvasTabs",
  "closeRightCanvasTabs",
  "closeAllCanvasTabs",
  "closeCanvasPane",
  "applyNestedRouteFocus",
];

export const TAB_NAVIGATION_STORE_ACTION_BANS = [
  {
    storeName: "useEpicCanvasStore",
    actionNames: ["setActiveTab"],
    message:
      "Do not access setActiveTab directly - route through navigateToTabIntent in lib/tab-navigation.ts so every entry point performs the same activate-then-navigate dance.",
  },
  {
    storeName: "useLandingDraftStore",
    actionNames: ["setActiveDraft"],
    message:
      "Do not access setActiveDraft directly - route through navigateToTabIntent in lib/tab-navigation.ts so every entry point performs the same activate-then-navigate dance.",
  },
];

const TAB_ACTIVATE_IMPORT_MESSAGE =
  "Do not import tabActivate outside lib/tab-navigation.ts. Use activateTabIntent so layout activation and the exact-entry navigation envelope stay coupled.";
const TAB_ACTIVATE_ACCESS_MESSAGE =
  "Do not access tabActivate outside lib/tab-navigation.ts. Use activateTabIntent so layout activation and the exact-entry navigation envelope stay coupled.";
const TAB_ACTIVATE_DESTRUCTURE_MESSAGE =
  "Do not destructure tabActivate outside lib/tab-navigation.ts. Use activateTabIntent so layout activation and the exact-entry navigation envelope stay coupled.";

const RAW_TAB_ACTIVATION_RESTRICTIONS = [
  {
    // Named import: import { tabActivate } / import { tabActivate as x }.
    selector:
      "ImportSpecifier[imported.type='Identifier'][imported.name='tabActivate']",
    message: TAB_ACTIVATE_IMPORT_MESSAGE,
  },
  {
    // Quoted named import: import { "tabActivate" as x }. `imported` is a Literal
    // here, not an Identifier, so the selector above misses it.
    selector:
      "ImportSpecifier[imported.type='Literal'][imported.value='tabActivate']",
    message: TAB_ACTIVATE_IMPORT_MESSAGE,
  },
  {
    // Dot member: registry.tabActivate.
    selector: "MemberExpression[computed=false][property.name='tabActivate']",
    message: TAB_ACTIVATE_ACCESS_MESSAGE,
  },
  {
    // String-computed member: registry["tabActivate"].
    selector:
      "MemberExpression[computed=true][property.type='Literal'][property.value='tabActivate']",
    message: TAB_ACTIVATE_ACCESS_MESSAGE,
  },
  {
    // Template-computed member: registry[`tabActivate`]. A no-substitution
    // template literal is NOT a Literal node.
    selector:
      "MemberExpression[computed=true][property.type='TemplateLiteral'][property.quasis.0.value.cooked='tabActivate']",
    message: TAB_ACTIVATE_ACCESS_MESSAGE,
  },
  {
    // ANY destructuring that extracts a `tabActivate` binding - declaration
    // (`const { tabActivate } = ...`), assignment (`({ tabActivate } = ...)`),
    // OR function parameter (`function f({ tabActivate }) {}`). `ObjectPattern`
    // only occurs in destructuring positions, so anchoring on it (not on
    // VariableDeclarator/AssignmentExpression) covers every context at once.
    // Matches shorthand and renamed-binding forms; `key.name` is the extracted
    // property, never a renamed local, so `{ x: tabActivate }` (binding named
    // tabActivate, extracting `x`) is correctly NOT flagged.
    selector:
      "ObjectPattern > Property[key.type='Identifier'][key.name='tabActivate']",
    message: TAB_ACTIVATE_DESTRUCTURE_MESSAGE,
  },
  {
    // String-literal key: { ["tabActivate"]: x } / { "tabActivate": x }.
    selector:
      "ObjectPattern > Property[key.type='Literal'][key.value='tabActivate']",
    message: TAB_ACTIVATE_DESTRUCTURE_MESSAGE,
  },
  {
    // Template-literal key: { [`tabActivate`]: x }.
    selector:
      "ObjectPattern > Property[key.type='TemplateLiteral'][key.quasis.0.value.cooked='tabActivate']",
    message: TAB_ACTIVATE_DESTRUCTURE_MESSAGE,
  },
];

function storeActionRestrictions(storeName, actionNames, message) {
  if (actionNames.length === 0) return [];

  const namePattern = actionNames.join("|");
  return [
    {
      selector: `CallExpression[callee.name='${storeName}'] > ArrowFunctionExpression[body.type='MemberExpression'][body.computed=false][body.property.name=/^(${namePattern})$/]`,
      message,
    },
    {
      selector: `CallExpression[callee.name='${storeName}'] > CallExpression > ArrowFunctionExpression[body.type='MemberExpression'][body.computed=false][body.property.name=/^(${namePattern})$/]`,
      message,
    },
    {
      selector: `CallExpression[callee.name='${storeName}'] > ArrowFunctionExpression[body.type='MemberExpression'][body.computed=true][body.property.type='Literal'][body.property.value=/^(${namePattern})$/]`,
      message,
    },
    {
      selector: `CallExpression[callee.name='${storeName}'] > CallExpression > ArrowFunctionExpression[body.type='MemberExpression'][body.computed=true][body.property.type='Literal'][body.property.value=/^(${namePattern})$/]`,
      message,
    },
    {
      selector: `CallExpression[callee.name='${storeName}'] > ArrowFunctionExpression[body.type='BlockStatement'] ReturnStatement > MemberExpression[computed=false][property.name=/^(${namePattern})$/]`,
      message,
    },
    {
      selector: `CallExpression[callee.name='${storeName}'] > CallExpression > ArrowFunctionExpression[body.type='BlockStatement'] ReturnStatement > MemberExpression[computed=false][property.name=/^(${namePattern})$/]`,
      message,
    },
    {
      selector: `CallExpression[callee.name='${storeName}'] > ArrowFunctionExpression[body.type='BlockStatement'] ReturnStatement > MemberExpression[computed=true][property.type='Literal'][property.value=/^(${namePattern})$/]`,
      message,
    },
    {
      selector: `CallExpression[callee.name='${storeName}'] > CallExpression > ArrowFunctionExpression[body.type='BlockStatement'] ReturnStatement > MemberExpression[computed=true][property.type='Literal'][property.value=/^(${namePattern})$/]`,
      message,
    },
    {
      selector: `CallExpression[callee.type='MemberExpression'][callee.computed=false][callee.property.name=/^(${namePattern})$/][callee.object.type='CallExpression'][callee.object.callee.object.name='${storeName}'][callee.object.callee.property.name='getState']`,
      message,
    },
    {
      selector: `CallExpression[callee.type='MemberExpression'][callee.computed=true][callee.property.type='Literal'][callee.property.value=/^(${namePattern})$/][callee.object.type='CallExpression'][callee.object.callee.object.name='${storeName}'][callee.object.callee.property.name='getState']`,
      message,
    },
    {
      selector: `VariableDeclarator[id.type='ObjectPattern'][init.type='CallExpression'][init.callee.object.name='${storeName}'][init.callee.property.name='getState'] > ObjectPattern > Property[key.type='Identifier'][key.name=/^(${namePattern})$/]`,
      message,
    },
    {
      selector: `VariableDeclarator[id.type='ObjectPattern'][init.type='CallExpression'][init.callee.object.name='${storeName}'][init.callee.property.name='getState'] > ObjectPattern > Property[key.type='Literal'][key.value=/^(${namePattern})$/]`,
      message,
    },
  ];
}

/**
 * Builds the `no-restricted-syntax` selectors banning raw access to
 * `EpicCanvasStore`'s focus-mutating actions, for the names NOT listed in
 * `allowedNames`. Pass `[]` for the fully-restricted general case; pass the
 * specific names a file legitimately needs for a scoped override.
 */
export function nestedFocusBoundaryRestrictions(allowedNames) {
  const restrictedNames = NESTED_FOCUS_BOUNDARY_ACTION_NAMES.filter(
    (name) => !allowedNames.includes(name),
  );
  if (restrictedNames.length === 0) return [];

  return storeActionRestrictions(
    "useEpicCanvasStore",
    restrictedNames,
    "Do not access a raw focus-mutating canvas store action. Use useEpicTileNavigation (or useEpicNestedFocusNavigation + the matching prepare...FocusTarget) so the resulting focus is committed to the route.",
  );
}

export function tabNavigationStoreActionRestrictions(allowedStoreActions) {
  const storeRestrictions = TAB_NAVIGATION_STORE_ACTION_BANS.flatMap((ban) =>
    storeActionRestrictions(
      ban.storeName,
      ban.actionNames.filter(
        (actionName) =>
          !allowedStoreActions.includes(`${ban.storeName}.${actionName}`),
      ),
      ban.message,
    ),
  );
  return [...storeRestrictions, ...RAW_TAB_ACTIVATION_RESTRICTIONS];
}
