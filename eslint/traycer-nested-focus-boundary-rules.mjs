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

/**
 * Builds the two `no-restricted-syntax` selectors banning raw access to
 * `EpicCanvasStore`'s focus-mutating actions, for the names NOT listed in
 * `allowedNames`. Pass `[]` for the fully-restricted general case; pass the
 * specific names a file legitimately needs for a scoped override.
 */
export function nestedFocusBoundaryRestrictions(allowedNames) {
  const restrictedNames = NESTED_FOCUS_BOUNDARY_ACTION_NAMES.filter(
    (name) => !allowedNames.includes(name),
  );
  if (restrictedNames.length === 0) return [];

  const namePattern = restrictedNames.join("|");
  return [
    {
      selector: `CallExpression[callee.name='useEpicCanvasStore'] > ArrowFunctionExpression[body.type='MemberExpression'][body.property.name=/^(${namePattern})$/]`,
      message:
        "Do not select a raw focus-mutating canvas store action. Use useEpicTileNavigation (or useEpicNestedFocusNavigation + the matching prepare...FocusTarget) so the resulting focus is committed to the route.",
    },
    {
      selector: `CallExpression[callee.type='MemberExpression'][callee.property.name=/^(${namePattern})$/][callee.object.type='CallExpression'][callee.object.callee.object.name='useEpicCanvasStore'][callee.object.callee.property.name='getState']`,
      message:
        "Do not call a raw focus-mutating canvas store action via getState(). Use useEpicTileNavigation (or useEpicNestedFocusNavigation + the matching prepare...FocusTarget) so the resulting focus is committed to the route.",
    },
  ];
}
