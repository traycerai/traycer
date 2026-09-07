import {
  js,
  tseslint,
  globals,
  commonIgnores,
  linterOptionsConfig,
} from "../../eslint/flat-base.mjs";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import react from "eslint-plugin-react";
import reactRefresh from "eslint-plugin-react-refresh";
import pluginQuery from "@tanstack/eslint-plugin-query";
import pluginRouter from "@tanstack/eslint-plugin-router";
import oxlint from "eslint-plugin-oxlint";
import { traycerClientsImportBoundaryRestrictions } from "../../eslint/traycer-clients-import-boundary-rules.mjs";
import {
  nestedFocusBoundaryRestrictions,
  tabNavigationStoreActionRestrictions,
} from "../../eslint/traycer-nested-focus-boundary-rules.mjs";
import {
  LINK_EGRESS_BRIDGE_RESTRICTIONS,
  LINK_EGRESS_DOM_RESTRICTIONS,
  LINK_EGRESS_HOOK_RESTRICTIONS,
  LINK_EGRESS_RESTRICTIONS,
  TILE_OPEN_RESTRICTIONS,
} from "../../eslint/traycer-tile-open-boundary-rules.mjs";
import {
  hostSelectionReadAllowlist,
  hostSelectionReadImportRestrictions,
  selectByIdRestrictions,
  selectionAuthorityRestrictions,
  selectionAuthorityWriteAllowlist,
  selectionKernelImportRestrictions,
  selectionKernelOwner,
} from "../../eslint/traycer-host-selection-layer-rules.mjs";

// Flat config replaces a rule's options; it does not merge them. Compose dimensions; do not append a from-scratch block.
const importRestrictionDimensions = {
  posthog: [
    {
      group: ["posthog-js", "posthog-js/*"],
      message:
        "Import PostHog only through the typed adapter in @/lib/analytics.",
    },
  ],
  readPath: hostSelectionReadImportRestrictions.patterns,
  kernel: selectionKernelImportRestrictions.patterns,
  // Overlay portals stay in shadcn wrappers. Scoped by `importNames`: packages also export non-portal utilities.
  overlayPortal: [
    {
      group: ["radix-ui"],
      importNames: [
        "AlertDialog",
        "ContextMenu",
        "Dialog",
        "DropdownMenu",
        "HoverCard",
        "Menubar",
        "NavigationMenu",
        "Popover",
        "Portal",
        "Select",
        "Toast",
        "Tooltip",
      ],
      message:
        "Overlay portal primitives are built only by the shadcn wrappers in src/components/ui/**. Use the wrapper - Dialog/Popover/Select/DropdownMenu/Tooltip/ContextMenu/HoverCard from @/components/ui/* - instead of importing the Radix primitive directly.",
    },
    {
      group: ["radix-ui/internal"],
      importNames: [
        "DismissableLayer",
        "FocusGuards",
        "FocusScope",
        "Menu",
        "Popper",
        "Presence",
        "Primitive",
        "RovingFocus",
      ],
      message:
        "These radix-ui/internal exports hand-build overlay behavior (positioning, dismiss, focus) outside the registered wrappers. Use the shadcn wrapper in src/components/ui/** instead. `useComposedRefs` and the other ref/state utilities are unrestricted.",
    },
    {
      group: ["vaul"],
      message:
        "vaul is wrapped by @/components/ui/sheet and @/components/ui/drawer, which register with the browser-tile occlusion coordinator. Use the wrapper instead of importing vaul directly.",
    },
    {
      group: ["@radix-ui/*"],
      message:
        "Radix primitive packages (@radix-ui/react-dialog, @radix-ui/react-dismissable-layer, ...) are wrapped by the shadcn components in src/components/ui/**. Use the wrapper instead of importing a @radix-ui/* package directly.",
    },
    {
      // `regex`, not `group`: a slash-less `group` matches any last path segment named "sonner", including `@/components/ui/sonner`.
      regex: "^sonner$",
      importNames: ["Toaster"],
      message:
        'The sonner <Toaster/> portal is mounted once by @/components/ui/sonner, which registers with the browser-tile occlusion coordinator. Import `toast` from "sonner" to trigger a toast; do not mount another <Toaster/>.',
    },
    {
      group: ["cmdk"],
      importNames: ["Command", "CommandDialog", "CommandRoot"],
      message:
        "The cmdk Command root is wrapped by @/components/ui/command, which registers with the browser-tile occlusion coordinator. Use the wrapper's exports instead of importing cmdk's Command directly.",
    },
  ],
};

/** The `boundary` dimension plus whichever others this file set carries. */
function importRestrictions(...dimensions) {
  return [
    "error",
    {
      ...traycerClientsImportBoundaryRestrictions,
      patterns: [
        ...(traycerClientsImportBoundaryRestrictions.patterns ?? []),
        ...dimensions.flatMap((name) => importRestrictionDimensions[name]),
      ],
    },
  ];
}

/** Every test file, in the two spellings the read-path allowlist already uses. */
const testFileGlobs = [
  "**/__tests__/**/*.{ts,tsx}",
  "**/*.{test,spec}.{ts,tsx}",
];

// App-wide host-read exemptions, per file never a directory.
const epicCanvasAppWideReadExemptions = [
  // Canvas host-id fallback for surfaces rendered outside any Epic session.
  "src/components/epic-canvas/hooks/use-canvas-host-id.ts",
  // Clone target is the host the app is now pointed at.
  "src/components/epic-canvas/renderers/use-chat-clone-on-host-switch.ts",
];

// `src/hooks/epic/**` hooks mounted only from app-wide surfaces. Never add a session-mounted call site.
const hooksEpicAppWideByCallerExemptions = [
  // Home page history (`hooks/home/use-history-query.ts`).
  "src/hooks/epic/use-epic-get-task-contexts-query.ts",
  // Epics list panel.
  "src/hooks/epic/use-task-delete-worktree-candidates-query.ts",
  "src/hooks/epic/use-epic-title-mutation.ts",
  "src/hooks/epic/use-epic-batch-delete-mutation.ts",
  // Epics list panel + tab strip.
  "src/hooks/epic/use-epic-set-pinned-mutation.ts",
  // Tab strip.
  "src/hooks/epic/use-epic-task-pinned-states-query.ts",
  // Sweep-worktrees dialog (app-wide).
  "src/hooks/epic/use-epic-sweep-worktree-candidates-query.ts",
  // Epic route, above the session provider; reader is on the same app-wide client.
  "src/hooks/epic/use-epic-record-viewed-mutation.ts",
  // Composer placement seam (app-wide, with a pre-flight host fence).
  "src/hooks/epic/use-epic-chat-mutations.ts",
];

// Following surface with no picker of its own, local-only by its own gate.
const followingSurfaceAppWideReadExemptions = [
  "src/components/worktree/open-in-editor-button.tsx",
];

// App chrome mounted above the shell split; not inside any tab, session, or picker.
const appChromeAppWideReadExemptions = [
  "src/components/session-import/session-import-run-controller.tsx",
];

// Re-impose `readPath` so a wrapper hook cannot launder `useHostClient()` for an Epic surface.
const hookDirectoriesRepointedToCallerClients = [
  "src/hooks/comments/**/*.{ts,tsx}",
  "src/hooks/snapshots/**/*.{ts,tsx}",
  "src/hooks/terminal/**/*.{ts,tsx}",
  "src/hooks/editor/**/*.{ts,tsx}",
];

// App-wide `useEditorOpen` wrapper for the following surface; Epic callers use `useEditorOpenForClient`.
const hookWrapperAppWideReadExemptions = [
  "src/hooks/editor/use-editor-open-mutation.ts",
];

const analyticsAdapterFiles = [
  "src/lib/analytics.ts",
  "src/lib/__tests__/analytics.test.ts",
];

// Do not subscribe to the entire Zustand store - reused across the base rules
// and the overrides that still need to ban it.
const noFullStoreSubscription = {
  selector:
    "CallExpression[callee.name=/^use[A-Z][a-zA-Z]*Store$/][arguments.length=0]",
  message:
    "Do not subscribe to the entire Zustand store. Pass a granular selector: useXxxStore((s) => s.specificField).",
};

// Named individually so per-file overrides can recompose the full set minus one entry.
const jsxKeyNullishCoalesceLiteral = {
  selector:
    "JSXAttribute[name.name='key'] > JSXExpressionContainer > LogicalExpression[operator='??'][right.type='Literal']",
  message:
    "Do not add literal nullish-coalescing fallbacks to JSX keys. Let the key be undefined unless you need a real identity fallback.",
};
const jsxKeyNullishCoalesceTemplate = {
  selector:
    "JSXAttribute[name.name='key'] > JSXExpressionContainer > LogicalExpression[operator='??'][right.type='TemplateLiteral'][right.expressions.length=0]",
  message:
    "Do not add literal nullish-coalescing fallbacks to JSX keys. Let the key be undefined unless you need a real identity fallback.",
};
const forwardRefImportBan = {
  selector: "ImportSpecifier[imported.name='forwardRef']",
  message:
    "React 19 treats refs as regular props. Type and destructure a `ref` prop instead of importing forwardRef.",
};
const forwardRefCallBan = {
  selector: "CallExpression[callee.name='forwardRef']",
  message:
    "React 19 treats refs as regular props. Type and destructure a `ref` prop instead of wrapping the component in forwardRef.",
};
const reactForwardRefCallBan = {
  selector:
    "CallExpression[callee.type='MemberExpression'][callee.object.name='React'][callee.property.name='forwardRef']",
  message:
    "React 19 treats refs as regular props. Type and destructure a `ref` prop instead of wrapping the component in React.forwardRef.",
};
// Ban native `title=` tooltips on real DOM tags. Lowercase names only: `title` is a heading prop on many components. Semantic exceptions: iframe, abbr, dfn, metadata/option tags.
const nativeTitleTooltipDomBan = {
  selector:
    "JSXOpeningElement[name.name=/^(?!(iframe|abbr|dfn|optgroup|option|track|link|style|meta)$)[a-z][a-zA-Z0-9-]*$/] > JSXAttribute[name.name='title']",
  message:
    "Do not use the native `title` attribute as a tooltip. Wrap the element in <TooltipWrapper label={...}> (@/components/ui/tooltip-wrapper), and keep `aria-label` for the accessible name.",
};

// Shared primitives that forward `title` onto a DOM node. App wrappers take `tooltip` instead and need no rule.
const nativeTitleTooltipForwardingBan = {
  selector:
    "JSXOpeningElement[name.name=/^(Button|Badge|DropdownMenuItem|DropdownMenuTrigger|DialogTrigger|PopoverTrigger|SelectTrigger|Switch|ToolbarIconButton|ToolbarPillButton|StartTruncatedText|NodeViewWrapper|WorktreePickerTrigger)$/] > JSXAttribute[name.name='title']",
  message:
    "This component forwards `title` to a DOM node, making it a native tooltip. Wrap it in <TooltipWrapper label={...}> (@/components/ui/tooltip-wrapper) instead.",
};

const epicTabRouteConstructionBan = {
  selector: "CallExpression[callee.name='epicTabRoute']",
  message:
    "Do not construct epicTabRoute() at the call site - pass an `existingEpicTabIntent({...})` (or similar TabNavigationIntent) to navigateToTabIntent; the route shape is owned by lib/tab-navigation.ts and lib/routes.ts.",
};
const tabNavigationStoreActionBans = tabNavigationStoreActionRestrictions([]);

// Overrides that scope out a boundary action must still spread this array back in, not write a from-scratch value.
const generalCustomSyntaxRestrictions = [
  jsxKeyNullishCoalesceLiteral,
  jsxKeyNullishCoalesceTemplate,
  nativeTitleTooltipDomBan,
  nativeTitleTooltipForwardingBan,
  forwardRefImportBan,
  forwardRefCallBan,
  reactForwardRefCallBan,
  ...tabNavigationStoreActionBans,
  epicTabRouteConstructionBan,
  ...selectByIdRestrictions,
  ...selectionAuthorityRestrictions,
  ...LINK_EGRESS_RESTRICTIONS,
  ...TILE_OPEN_RESTRICTIONS,
];

// `no-restricted-syntax` is composed the same way: a block names what it is exempt from. Identity is by reference; do not rebuild the memoized consts.
const syntaxExemptions = {
  jsxKey: [jsxKeyNullishCoalesceLiteral, jsxKeyNullishCoalesceTemplate],
  nativeTitleTooltip: [
    nativeTitleTooltipDomBan,
    nativeTitleTooltipForwardingBan,
  ],
  forwardRef: [forwardRefImportBan, forwardRefCallBan, reactForwardRefCallBan],
  tabNavigation: tabNavigationStoreActionBans,
  epicTabRoute: [epicTabRouteConstructionBan],
  selectById: selectByIdRestrictions,
  selectionAuthority: selectionAuthorityRestrictions,
  // Two groups: tests lift the bridge half and keep the DOM half.
  linkEgressBridge: LINK_EGRESS_BRIDGE_RESTRICTIONS,
  linkEgressHook: LINK_EGRESS_HOOK_RESTRICTIONS,
  linkEgressDom: LINK_EGRESS_DOM_RESTRICTIONS,
  tileOpen: TILE_OPEN_RESTRICTIONS,
};

/** All three options are required. `null` means the family does not apply; `[]` means applies with no allowances. Passing `tabNavigation` a list also lifts the un-allowanced tabNavigation bans. */
function syntaxRestrictions({ exempt, nestedFocus, tabNavigation }) {
  for (const name of exempt) {
    if (syntaxExemptions[name] === undefined) {
      throw new Error(`Unknown no-restricted-syntax exemption: ${name}`);
    }
  }
  const lifted = new Set(exempt.flatMap((name) => syntaxExemptions[name]));
  if (tabNavigation !== null) {
    for (const ban of syntaxExemptions.tabNavigation) lifted.add(ban);
  }
  return [
    "error",
    noFullStoreSubscription,
    ...generalCustomSyntaxRestrictions.filter(
      (restriction) => !lifted.has(restriction),
    ),
    ...(nestedFocus === null
      ? []
      : nestedFocusBoundaryRestrictions(nestedFocus)),
    ...(tabNavigation === null
      ? []
      : tabNavigationStoreActionRestrictions(tabNavigation)),
  ];
}

export default tseslint.config(
  { ignores: [...commonIgnores, "src/routeTree.gen.ts"] },
  linterOptionsConfig,
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  jsxA11y.flatConfigs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node, ...globals.es2021 },
    },
    settings: {
      react: { version: "detect" },
    },
    plugins: {
      "react-refresh": reactRefresh,
      "@tanstack/query": pluginQuery,
      "@tanstack/router": pluginRouter,
      react,
    },
    rules: {
      // ── react-refresh ──────────────────────────────────────────────────────
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],

      // ── @typescript-eslint: base ────────────────────────────────────────────
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",

      // ── @typescript-eslint: strict additions ────────────────────────────────
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/return-await": ["error", "in-try-catch"],
      "@typescript-eslint/no-deprecated": "warn",
      "@typescript-eslint/no-unnecessary-boolean-literal-compare": "error",
      "@typescript-eslint/no-unnecessary-type-arguments": "error",
      "@typescript-eslint/unified-signatures": "error",
      "@typescript-eslint/prefer-as-const": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",

      // ── TanStack Query ──────────────────────────────────────────────────────
      "@tanstack/query/exhaustive-deps": "error",
      "@tanstack/query/no-rest-destructuring": "warn",
      "@tanstack/query/stable-query-client": "error",
      "@tanstack/query/no-unstable-deps": "error",
      "@tanstack/query/no-void-query-fn": "error",
      "@tanstack/query/prefer-query-options": "warn",
      "@tanstack/query/infinite-query-property-order": "error",
      "@tanstack/query/mutation-property-order": "error",

      // ── TanStack Router ─────────────────────────────────────────────────────
      "@tanstack/router/create-route-property-order": "error",

      // ── React: correctness ──────────────────────────────────────────────────
      "react/no-array-index-key": "error",
      "react/jsx-no-leaked-render": "error",
      "react/jsx-no-target-blank": "error",
      "react/no-danger": "error",
      "react/no-unstable-nested-components": "error",
      "react/jsx-key": ["error", { checkFragmentShorthand: true }],
      "react/no-deprecated": "error",
      "react/no-direct-mutation-state": "error",

      // ── React: style / redundancy ───────────────────────────────────────────
      "react/self-closing-comp": "warn",
      "react/jsx-boolean-value": ["warn", "never"],
      "react/jsx-no-useless-fragment": ["warn", { allowExpressions: true }],

      // ── Import boundaries + full-store Zustand selectors ────────────────────
      // Dimensions: boundary + kernel + overlayPortal. Both ride the base block so neither ban has a hole outside `src`.
      "@typescript-eslint/no-restricted-imports": importRestrictions(
        "kernel",
        "overlayPortal",
      ),

      "no-restricted-syntax": syntaxRestrictions({
        exempt: [],
        nestedFocus: [],
        tabNavigation: null,
      }),

      // ── ESLint core: code quality ───────────────────────────────────────────
      complexity: ["warn", { max: 16 }],
      "max-depth": ["warn", { max: 4 }],
      "max-params": ["warn", { max: 4 }],
      "no-nested-ternary": "error",
      "no-else-return": "warn",
      eqeqeq: ["error", "always"],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "prefer-const": "error",
      "no-var": "error",
    },
  },

  // ── Per-directory overrides ─────────────────────────────────────────────────
  {
    // PostHog only through the typed adapter. The adapter's own test is the other legitimate consumer.
    files: ["src/**/*.{ts,tsx}"],
    ignores: analyticsAdapterFiles,
    rules: {
      "@typescript-eslint/no-restricted-imports": importRestrictions(
        "posthog",
        "kernel",
        "overlayPortal",
      ),
    },
  },
  {
    // Ban active-host / default-client hook imports outside the allowlisted layer. Allowlisted files are not a subset of this set.
    files: ["src/**/*.{ts,tsx}"],
    ignores: [...analyticsAdapterFiles, ...hostSelectionReadAllowlist],
    rules: {
      "@typescript-eslint/no-restricted-imports": importRestrictions(
        "posthog",
        "readPath",
        "kernel",
        "overlayPortal",
      ),
    },
  },
  {
    // Re-impose `readPath` on `src/hooks/epic/**` (inside the hooks allowlist) minus the by-caller exemptions.
    files: ["src/hooks/epic/**/*.{ts,tsx}"],
    ignores: [...testFileGlobs, ...hooksEpicAppWideByCallerExemptions],
    rules: {
      "@typescript-eslint/no-restricted-imports": importRestrictions(
        "posthog",
        "readPath",
        "kernel",
        "overlayPortal",
      ),
    },
  },
  {
    // Same re-imposition for wrapper-hook directories that take caller-supplied clients.
    files: hookDirectoriesRepointedToCallerClients,
    ignores: [...testFileGlobs, ...hookWrapperAppWideReadExemptions],
    rules: {
      "@typescript-eslint/no-restricted-imports": importRestrictions(
        "posthog",
        "readPath",
        "kernel",
        "overlayPortal",
      ),
    },
  },
  {
    // App-wide reads, per file: their partition minus `readPath`.
    files: [
      ...epicCanvasAppWideReadExemptions,
      ...followingSurfaceAppWideReadExemptions,
      ...appChromeAppWideReadExemptions,
      ...hookWrapperAppWideReadExemptions,
    ],
    rules: {
      "@typescript-eslint/no-restricted-imports": importRestrictions(
        "posthog",
        "kernel",
        "overlayPortal",
      ),
    },
  },
  {
    // Promotable-modal family builds custom dialog chrome the shadcn Dialog wrapper does not support.
    files: [
      "src/components/layout/dialogs/promotable-modal-frame.tsx",
      "src/components/layout/dialogs/window-host-modal.tsx",
      "src/components/layout/dialogs/migration-blocking-modal-host.tsx",
      "src/components/layout/dialogs/system-tab-modal-host.tsx",
    ],
    rules: {
      "@typescript-eslint/no-restricted-imports": importRestrictions(
        "posthog",
        "kernel",
      ),
    },
  },
  {
    // Tests lift `kernel` only. Their partition is already boundary + posthog.
    files: testFileGlobs,
    // Adapter's own test: earlier `ignores` would be overwritten by last-block-wins without this.
    ignores: analyticsAdapterFiles,
    rules: {
      "@typescript-eslint/no-restricted-imports": importRestrictions("posthog"),
    },
  },
  {
    // Kernel owner lifts `kernel` for itself alone. Single-file `files` so a directory glob cannot shadow a broad block.
    files: selectionKernelOwner,
    rules: {
      "@typescript-eslint/no-restricted-imports": importRestrictions(
        "posthog",
        "overlayPortal",
      ),
    },
  },
  {
    // Only Settings Activate and the bridge composition root may reach the preferred-write API.
    files: selectionAuthorityWriteAllowlist,
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: ["selectionAuthority"],
        nestedFocus: [],
        tabNavigation: null,
      }),
    },
  },
  {
    // Markdown author `title` belongs on the anchor. Routing it through `TooltipWrapper` would restyle author content as app UI.
    files: ["src/markdown/components/markdown-anchor.tsx"],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: ["nativeTitleTooltip"],
        nestedFocus: [],
        tabNavigation: null,
      }),
    },
  },
  {
    // shadcn wrappers are the overlayPortal allowance. Restate the partition minus `overlayPortal`.
    files: ["src/components/ui/**/*.tsx"],
    rules: {
      "@typescript-eslint/no-restricted-imports": importRestrictions(
        "posthog",
        "readPath",
        "kernel",
      ),
      "react-refresh/only-export-components": "off",
      "react-hooks/purity": "off",
      "@tanstack/query/no-rest-destructuring": "off",
      "jsx-a11y/click-events-have-key-events": "off",
      "jsx-a11y/no-noninteractive-element-interactions": "off",
    },
  },
  {
    // Raw-primitive consumers restated minus `overlayPortal` so they do not inherit shadcn-only turn-offs.
    files: [
      "src/components/epic-canvas/dialogs/epic-migration-modal.tsx",
      "src/components/command-palette/palette-item-row.tsx",
    ],
    rules: {
      "@typescript-eslint/no-restricted-imports": importRestrictions(
        "posthog",
        "readPath",
        "kernel",
      ),
    },
  },
  {
    // Activation module owns raw tabActivate. Restate selection bans individually: spreading `generalCustomSyntaxRestrictions` would bring back tabNavigation bans this block must not have.
    files: ["src/lib/tab-navigation.ts"],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: [
          "jsxKey",
          "nativeTitleTooltip",
          "forwardRef",
          "tabNavigation",
          "epicTabRoute",
        ],
        nestedFocus: null,
        tabNavigation: null,
      }),
    },
  },
  {
    // Coordinator may call the two legacy source selectors; raw registry.tabActivate stays banned.
    files: ["src/stores/tabs/tab-command-coordinator.ts"],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: [],
        nestedFocus: null,
        tabNavigation: [
          "useEpicCanvasStore.setActiveTab",
          "useLandingDraftStore.setActiveDraft",
        ],
      }),
    },
  },
  {
    // Source half of tab-navigation's single activation boundary. Keep raw tabActivate restricted.
    files: ["src/stores/tabs/kinds/draft.tsx"],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: [],
        nestedFocus: null,
        tabNavigation: ["useLandingDraftStore.setActiveDraft"],
      }),
    },
  },
  {
    // Epic descriptor owns canonical route construction; callers still cannot access raw tabActivate.
    files: ["src/stores/tabs/kinds/epic.tsx"],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: ["epicTabRoute"],
        nestedFocus: null,
        tabNavigation: ["useEpicCanvasStore.setActiveTab"],
      }),
    },
  },
  {
    // Tests may seed via setActiveTab / setActiveDraft. Raw `tabActivate` stays banned.
    files: ["src/**/__tests__/**/*.{ts,tsx}", "**/__tests__/**/*.{ts,tsx}"],
    rules: {
      // Tests: lift property-name bans that would flag assertions proving the invariant, and shipped-surface bans on test doubles. Keep `linkEgressDom`.
      "no-restricted-syntax": syntaxRestrictions({
        exempt: [
          "nativeTitleTooltip",
          "forwardRef",
          "selectById",
          "selectionAuthority",
          "tileOpen",
          "linkEgressBridge",
          "linkEgressHook",
        ],
        nestedFocus: null,
        tabNavigation: [
          "useEpicCanvasStore.setActiveTab",
          "useLandingDraftStore.setActiveDraft",
        ],
      }),
    },
  },
  {
    // Acquire a shared session in `useEffect` so cleanup pairs with the committed acquire. A `useMemo` factory can run more than once per commit and orphan a live reference.
    files: [
      "src/hooks/host/use-host-client-for.ts",
      "src/hooks/host/use-host-stream-client-for.ts",
      "src/lib/host/stream-runtime.tsx",
    ],
    rules: {
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    // Router-to-store sync for an already-committed epic route. Inverse of navigateToTabIntent.
    files: ["src/routes/epic-tab-route-components.tsx"],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: [],
        nestedFocus: [],
        tabNavigation: ["useEpicCanvasStore.setActiveTab"],
      }),
    },
  },

  // Nested-focus-opener allowlist. Grep the two banned AST shapes before adding another.
  {
    // Route-to-store sync of an already-committed target, plus legacy auto-open when there is no nested route yet.
    files: [
      "src/components/epic-canvas/hooks/use-epic-route-synchronization.ts",
    ],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: [],
        nestedFocus: [
          "openTileInTab",
          "closeCanvasTab",
          "applyNestedRouteFocus",
        ],
        tabNavigation: null,
      }),
    },
  },
  {
    // Blank-root bootstrap: no prior focus to disambiguate, so nothing to write to the route.
    files: ["src/components/epic-canvas/canvas/tile-canvas.tsx"],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: [],
        nestedFocus: ["openTileInTab"],
        tabNavigation: null,
      }),
    },
  },
  {
    // Background-tab register never needs a route write (`prepareOpenTileInBackgroundTabFocusTarget` returns a null focus delta).
    files: [
      "src/hooks/worktree/use-register-setup-terminal-tabs-from-binding.ts",
    ],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: [],
        nestedFocus: ["openTileInBackgroundTab"],
        tabNavigation: null,
      }),
    },
  },
  {
    // Bulk-delete batches raw closeCanvasTab calls then commits one aggregate post-batch focus target.
    files: ["src/components/epic-canvas/sidebar/epic-sidebar.tsx"],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: [],
        nestedFocus: ["closeCanvasTab"],
        tabNavigation: null,
      }),
    },
  },
  // Link-egress allowlist: files below the `useOpenLink` seam, not bypassing it.
  {
    // Desktop bridge: the one door out of the app, called by `useOpenLink` for external links.
    files: ["src/lib/links/open-external-link.ts"],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: ["linkEgressBridge"],
        nestedFocus: [],
        tabNavigation: null,
      }),
    },
  },
  {
    // Only files allowed to hold the bridge hook: in-app vs external decision, and the failure toast's "Open in browser".
    files: ["src/lib/links/open-link.ts", "src/lib/links/open-browser-url.ts"],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: ["linkEgressHook"],
        nestedFocus: [],
        tabNavigation: null,
      }),
    },
  },
  {
    // OAuth verification URLs are hard-external. This module runs outside React, so the hook form is unavailable.
    files: ["src/lib/auth/auth-service.ts"],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: ["linkEgressBridge"],
        nestedFocus: [],
        tabNavigation: null,
      }),
    },
  },

  // Tile-open allowlist: the seam, the store, and two callers below it. Single-level globs so they do not shadow `tile-open/__tests__/`.
  {
    files: [
      "src/lib/canvas/tile-open/*.{ts,tsx}",
      "src/hooks/epic/use-epic-tile-navigation.ts",
    ],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: ["tileOpen"],
        nestedFocus: [],
        tabNavigation: null,
      }),
    },
  },
  {
    // Store defines every `prepare*FocusTarget`; the seam is a boundary around it.
    files: ["src/stores/epics/canvas/store.ts"],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: ["tileOpen"],
        nestedFocus: [],
        tabNavigation: null,
      }),
    },
  },

  // Keep oxlint last so ESLint retains repository-specific boundaries and selector-based invariants.
  ...oxlint.buildFromOxlintConfigFile(".oxlintrc.json"),
);
