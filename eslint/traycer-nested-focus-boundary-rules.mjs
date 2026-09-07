/**
 * Ban raw focus-mutating `useEpicCanvasStore` actions outside the nested-focus opener; they skip the route search params back/forward and reload need.
 * Alias flow is a known esquery limit. `promotePreviewInTab`, `resizeSplitInTab`, and header-tab creation are excluded: they do not write nested focus.
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
    // ObjectPattern covers declaration, assignment, and parameter destructuring. key.name is the extracted property, so `{ x: tabActivate }` is not flagged.
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
