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
import { traycerTypeSafetyRestrictions } from "../../eslint/traycer-type-safety-rules.mjs";
import { traycerClientsImportBoundaryRestrictions } from "../../eslint/traycer-clients-import-boundary-rules.mjs";
import {
  nestedFocusBoundaryRestrictions,
  tabNavigationStoreActionRestrictions,
} from "../../eslint/traycer-nested-focus-boundary-rules.mjs";

// Do not subscribe to the entire Zustand store - reused across the base rules
// and the overrides that still need to ban it.
const noFullStoreSubscription = {
  selector:
    "CallExpression[callee.name=/^use[A-Z][a-zA-Z]*Store$/][arguments.length=0]",
  message:
    "Do not subscribe to the entire Zustand store. Pass a granular selector: useXxxStore((s) => s.specificField).",
};

// Named individually (rather than left inline in the base rule array) so
// per-file overrides can recompose the full set minus one entry, instead of
// silently dropping all of them the way a from-scratch override array would.
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
const epicTabRouteConstructionBan = {
  selector: "CallExpression[callee.name='epicTabRoute']",
  message:
    "Do not construct epicTabRoute() at the call site - pass an `existingEpicTabIntent({...})` (or similar TabNavigationIntent) to navigateToTabIntent; the route shape is owned by lib/tab-navigation.ts and lib/routes.ts.",
};
const tabNavigationStoreActionBans = tabNavigationStoreActionRestrictions([]);

// Every general-purpose app file gets these regardless of the nested-focus-
// boundary allowlist below - overrides that scope out a boundary action must
// still spread this array back in, not drop it by writing a from-scratch
// `no-restricted-syntax` value.
const generalCustomSyntaxRestrictions = [
  jsxKeyNullishCoalesceLiteral,
  jsxKeyNullishCoalesceTemplate,
  forwardRefImportBan,
  forwardRefCallBan,
  reactForwardRefCallBan,
  ...tabNavigationStoreActionBans,
  epicTabRouteConstructionBan,
];

export default tseslint.config(
  { ignores: [...commonIgnores, "src/routeTree.gen.ts"] },
  linterOptionsConfig,
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  reactHooks.configs.flat.recommended,
  jsxA11y.flatConfigs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node, ...globals.es2021 },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
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
      "@typescript-eslint/no-restricted-imports": [
        "error",
        traycerClientsImportBoundaryRestrictions,
      ],

      "no-restricted-syntax": [
        "error",
        ...traycerTypeSafetyRestrictions,
        noFullStoreSubscription,
        ...generalCustomSyntaxRestrictions,
        ...nestedFocusBoundaryRestrictions([]),
      ],

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
    // PostHog is reachable only through the typed adapter so every event and
    // property passes its allowlist sanitizer before leaving the app. The
    // adapter's own test is the one other legitimate consumer: it drives the
    // real SDK through the sanitizer to prove the payload boundary.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/analytics.ts", "src/lib/__tests__/analytics.test.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          ...traycerClientsImportBoundaryRestrictions,
          patterns: [
            ...(traycerClientsImportBoundaryRestrictions.patterns ?? []),
            {
              group: ["posthog-js", "posthog-js/*"],
              message:
                "Import PostHog only through the typed adapter in @/lib/analytics.",
            },
          ],
        },
      ],
    },
  },
  {
    // shadcn/ui generated primitives follow library conventions that
    // intentionally diverge from app-code rules.
    files: ["src/components/ui/**/*.tsx"],
    rules: {
      "react-refresh/only-export-components": "off",
      "react-hooks/purity": "off",
      "@tanstack/query/no-rest-destructuring": "off",
      "jsx-a11y/click-events-have-key-events": "off",
      "jsx-a11y/no-noninteractive-element-interactions": "off",
    },
  },
  {
    // Tab navigation seam + store definitions own the primitives the
    // codebase-wide rules ban; only the type-safety + full-store bans apply.
    files: [
      "src/lib/tab-navigation.ts",
      "src/lib/routes.ts",
      "src/stores/epics/canvas/store.ts",
      "src/stores/home/landing-draft-store.ts",
      "src/stores/tabs/kinds/draft.tsx",
      "src/stores/tabs/kinds/epic.tsx",
      "src/stores/tabs/kinds/history.tsx",
      "src/stores/tabs/kinds/settings.tsx",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...traycerTypeSafetyRestrictions,
        noFullStoreSubscription,
      ],
    },
  },
  {
    // Test fixtures construct the full router interface and seed stores via
    // setActiveTab / setActiveDraft as part of arrange / act setup.
    files: ["src/**/__tests__/**/*.{ts,tsx}", "**/__tests__/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...traycerTypeSafetyRestrictions,
        noFullStoreSubscription,
      ],
    },
  },
  {
    // Router -> store synchronization direction for an already-committed epic
    // route. This is the inverse of navigateToTabIntent's entry-point seam,
    // so it may read the store action directly while the rest of the app may
    // not.
    files: ["src/routes/epic-tab-route-components.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...traycerTypeSafetyRestrictions,
        noFullStoreSubscription,
        ...generalCustomSyntaxRestrictions.filter(
          (restriction) => !tabNavigationStoreActionBans.includes(restriction),
        ),
        ...tabNavigationStoreActionRestrictions([
          "useEpicCanvasStore.setActiveTab",
        ]),
        ...nestedFocusBoundaryRestrictions([]),
      ],
    },
  },

  // ── Nested-focus-opener boundary allowlist ──────────────────────────────────
  // See eslint/traycer-nested-focus-boundary-rules.mjs for the contract this
  // enforces. Every entry below is a verified, empirical exception (grep the
  // codebase for the two banned AST shapes before adding another) - not a
  // restatement of the original audit brief, which over-listed several files
  // that turned out to already be boundary-backed.
  {
    // Route -> store sync direction: applies an already-resolved/committed
    // route target into the canvas (the inverse of the boundary, which goes
    // store -> route), plus the legacy pre-nested-focus auto-open/cleanup
    // paths that only run when there is no nested route target yet.
    files: [
      "src/components/epic-canvas/hooks/use-epic-route-synchronization.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...traycerTypeSafetyRestrictions,
        noFullStoreSubscription,
        ...generalCustomSyntaxRestrictions,
        ...nestedFocusBoundaryRestrictions([
          "openTileInTab",
          "closeCanvasTab",
          "applyNestedRouteFocus",
        ]),
      ],
    },
  },
  {
    // Blank-root bootstrap: seeds the first and only tile of a brand-new
    // empty canvas root. There is no prior focus to disambiguate, so there
    // is nothing meaningful to write to the route.
    files: ["src/components/epic-canvas/canvas/tile-canvas.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...traycerTypeSafetyRestrictions,
        noFullStoreSubscription,
        ...generalCustomSyntaxRestrictions,
        ...nestedFocusBoundaryRestrictions(["openTileInTab"]),
      ],
    },
  },
  {
    // Registers a server-created terminal as a saved background tab without
    // activating it - prepareOpenTileInBackgroundTabFocusTarget always
    // returns a null focus delta, so this call never needs a route write.
    // Both the chat and terminal-agent tab-register drivers delegate their
    // registration effect to this single shared hook, so the exemption lives
    // here, at the one site that actually calls openTileInBackgroundTab.
    files: [
      "src/hooks/worktree/use-register-setup-terminal-tabs-from-binding.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...traycerTypeSafetyRestrictions,
        noFullStoreSubscription,
        ...generalCustomSyntaxRestrictions,
        ...nestedFocusBoundaryRestrictions(["openTileInBackgroundTab"]),
      ],
    },
  },
  {
    // Bulk-delete batches N raw closeCanvasTab calls inside a hand-rolled
    // `prepare` closure passed to navigateNested, then commits ONE aggregate
    // post-batch focus target - the same raw-then-diff shape the store's own
    // prepare*FocusTarget wrappers use internally, just batched. Owned by a
    // sibling agent's in-progress bulk-delete fixup; re-verify this
    // classification if that implementation changes shape.
    files: ["src/components/epic-canvas/sidebar/epic-sidebar.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...traycerTypeSafetyRestrictions,
        noFullStoreSubscription,
        ...generalCustomSyntaxRestrictions,
        ...nestedFocusBoundaryRestrictions(["closeCanvasTab"]),
      ],
    },
  },
);
