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

// Do not subscribe to the entire Zustand store - reused across the base rules
// and the overrides that still need to ban it.
const noFullStoreSubscription = {
  selector:
    "CallExpression[callee.name=/^use[A-Z][a-zA-Z]*Store$/][arguments.length=0]",
  message:
    "Do not subscribe to the entire Zustand store. Pass a granular selector: useXxxStore((s) => s.specificField).",
};

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
        {
          selector:
            "JSXAttribute[name.name='key'] > JSXExpressionContainer > LogicalExpression[operator='??'][right.type='Literal']",
          message:
            "Do not add literal nullish-coalescing fallbacks to JSX keys. Let the key be undefined unless you need a real identity fallback.",
        },
        {
          selector:
            "JSXAttribute[name.name='key'] > JSXExpressionContainer > LogicalExpression[operator='??'][right.type='TemplateLiteral'][right.expressions.length=0]",
          message:
            "Do not add literal nullish-coalescing fallbacks to JSX keys. Let the key be undefined unless you need a real identity fallback.",
        },
        {
          selector: "ImportSpecifier[imported.name='forwardRef']",
          message:
            "React 19 treats refs as regular props. Type and destructure a `ref` prop instead of importing forwardRef.",
        },
        {
          selector: "CallExpression[callee.name='forwardRef']",
          message:
            "React 19 treats refs as regular props. Type and destructure a `ref` prop instead of wrapping the component in forwardRef.",
        },
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.object.name='React'][callee.property.name='forwardRef']",
          message:
            "React 19 treats refs as regular props. Type and destructure a `ref` prop instead of wrapping the component in React.forwardRef.",
        },
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name='setActiveTab']",
          message:
            "Do not call setActiveTab directly - route through navigateToTabIntent in lib/tab-navigation.ts so every entry point performs the same activate-then-navigate dance.",
        },
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name='setActiveDraft']",
          message:
            "Do not call setActiveDraft directly - route through navigateToTabIntent in lib/tab-navigation.ts so every entry point performs the same activate-then-navigate dance.",
        },
        {
          selector: "CallExpression[callee.name='epicTabRoute']",
          message:
            "Do not construct epicTabRoute() at the call site - pass an `existingEpicTabIntent({...})` (or similar TabNavigationIntent) to navigateToTabIntent; the route shape is owned by lib/tab-navigation.ts and lib/routes.ts.",
        },
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
);
