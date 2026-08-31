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
  hostSelectionReadAllowlist,
  hostSelectionReadImportRestrictions,
  selectByIdRestrictions,
  selectionAuthorityRestrictions,
  selectionAuthorityWriteAllowlist,
  selectionKernelImportRestrictions,
  selectionKernelOwner,
} from "../../eslint/traycer-host-selection-layer-rules.mjs";

// ── IMPORT RESTRICTIONS ARE COMPOSED FROM DIMENSIONS. READ THIS BEFORE ADDING ONE. ──
//
// Flat config REPLACES a rule's options; it does not merge them. So the LAST
// block matching a file supplies that file's ENTIRE
// `no-restricted-imports` value, and a new block appended with a from-scratch
// value silently switches OFF every restriction the earlier blocks set for the
// files it matches. Lint stays green. That failure is invisible in both
// directions and this config has already produced it twice.
//
// The idiom that caused it was RESTATEMENT: each block hand-copied the ones
// before it and added its own patterns. Four dimensions in, one dropped line is
// a deleted boundary nobody can see. So the dimensions are named and composed
// instead:
//
//   boundary  - the cross-package import boundary. Every file, always.
//   posthog   - PostHog only through the typed adapter. All of `src`, except
//               the adapter and its own test.
//   readPath  - D12: no active-host / default-client hooks outside the
//               allowlisted layer (`hostSelectionReadAllowlist`, which
//               deliberately includes every test).
//   kernel    - F2: only `renderer-selection-kernel.ts` may name
//               `SelectionEvidenceKernel` at runtime.
//
// The file sets are NOT nested, they PARTITION - `hostSelectionReadAllowlist`
// covers `src/hooks/**`, `src/lib/host/**` and all tests, so those files carry
// a different set from the rest of `src`. That is why one broad "add my ban"
// block cannot work: it would need to include `readPath` for some of the files
// it matches and omit it for others.
//
// TO ADD A RESTRICTION: add a dimension below, then name it in the blocks whose
// file sets should carry it. Do NOT append a block with a hand-written value.
// To EXEMPT one file, add a block whose `files` is that single file and whose
// dimensions are its partition's minus the one being lifted.
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

// ── App-wide host reads that are RIGHT where they are, exempted per FILE. ──
//
// `readPath` (D12) bans the app-wide reads across the Epic canvas subtree and
// `src/hooks/epic/**` (see the allowlist note in
// `traycer-host-selection-layer-rules.mjs`). Each file below carries a reason
// an app-wide read is the correct one THERE; a file without a reason does not
// belong here, and a reason that stops being true retires its line. Single
// files, never a directory: a directory glob would let the next file dropped
// in inherit the exemption unread.
const epicCanvasAppWideReadExemptions = [
  // The canvas host hook's own documented FALLBACK for a surface rendered
  // outside any Epic session (a Markdown reference outside a canvas); inside a
  // session the fallback is unreachable. It is the mechanism the rest of the
  // subtree resolves through, so it is the one place the read may live.
  "src/components/epic-canvas/hooks/use-canvas-host-id.ts",
  // Clone-not-migrate (D5/D7): the clone TARGET is, by design, the host the
  // app is now pointed at - a dead tile's chat is cloned onto the effective
  // host. Reading anything else here would clone onto a host nobody chose.
  "src/components/epic-canvas/renderers/use-chat-clone-on-host-switch.ts",
];

// `src/hooks/epic/**` hooks that resolve the app-wide client BY CALLER: each is
// mounted only from an app-wide surface (the epics list, the home page, the
// tab strip, the epic route above its session), never from inside an Epic
// session. A caller inside a session must use the session-scoped sibling or a
// `…ForClient` variant - never add a session-mounted call site to one of these.
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
  // Mounted by the epic ROUTE, above the session provider; its reader (the
  // home page's recents) is on the same app-wide client.
  "src/hooks/epic/use-epic-record-viewed-mutation.ts",
  // `useEpicCreateChat` is the composer PLACEMENT seam (ruled app-wide, with a
  // pre-flight host fence); every session-scoped hook in this file already
  // resolves `useEpicSessionHostClient` or takes a client.
  "src/hooks/epic/use-epic-chat-mutations.ts",
];

// The dead-tile "open in editor" opener is a FOLLOWING surface with no picker
// of its own (selection model §2), local-only by its own gate.
const followingSurfaceAppWideReadExemptions = [
  "src/components/worktree/open-in-editor-button.tsx",
];

// App chrome: mounted once above the shell split in `traycer-app.tsx`, so it is
// not inside any tab, Epic session, or picker surface whose host it could read
// instead. Session import runs against the host the app is pointed at, and the
// single subscription it owns outlives every wizard that watches it.
const appChromeAppWideReadExemptions = [
  "src/components/session-import/session-import-run-controller.tsx",
];

// Hook directories whose every RPC now takes the caller's client, because
// their surfaces are Epic-scoped (a tile's comments, a tile's snapshot
// blobs, a session's terminals) and the app-wide read they used to launder
// was invisible to `readPath`: the fence only sees a file's own imports, so
// a wrapper hook resolving `useHostClient()` on behalf of an Epic surface
// passed it. Re-impose `readPath` here so a new wrapper cannot re-open that
// channel (PR #1243 round 6, the hook-INDIRECTION half of the class).
const hookDirectoriesRepointedToCallerClients = [
  "src/hooks/comments/**/*.{ts,tsx}",
  "src/hooks/snapshots/**/*.{ts,tsx}",
  "src/hooks/terminal/**/*.{ts,tsx}",
  "src/hooks/editor/**/*.{ts,tsx}",
];

// `useEditorOpen`, the app-wide convenience wrapper kept for the following
// surface above (`open-in-editor-button.tsx`); every Epic-scoped caller uses
// `useEditorOpenForClient`.
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
// Native `title=` is a browser tooltip: ~700ms delay we do not control, no
// styling, no touch support, invisible to most screen readers as anything more
// than a duplicate of the accessible name, and it clips at the OS window edge.
// `TooltipWrapper` is the app's one tooltip surface.
//
// SCOPE: lowercase names only, i.e. real DOM tags. `title` is an ordinary React
// prop on plenty of components here (`SettingsPanelShell`, `SectionHeading`,
// `ConfirmDestructiveDialog`, …) where it is a heading, not a tooltip - a
// blanket ban on the attribute name would flag ~65 of those. The exceptions
// below are the tags where `title` is SEMANTIC rather than a hover hint:
// `iframe` (its accessible name - `jsx-a11y/iframe-has-title` actively requires
// it), `abbr`/`dfn` (expansion of the term), and the metadata/option tags that
// never render a hoverable box at all.
//
// Components that merely forward `title` to a DOM node (`Button`, `Badge`, …)
// are covered by the companion ban below - they are native tooltips wearing a
// capital letter.
const nativeTitleTooltipDomBan = {
  selector:
    "JSXOpeningElement[name.name=/^(?!(iframe|abbr|dfn|optgroup|option|track|link|style|meta)$)[a-z][a-zA-Z0-9-]*$/] > JSXAttribute[name.name='title']",
  message:
    "Do not use the native `title` attribute as a tooltip. Wrap the element in <TooltipWrapper label={...}> (@/components/ui/tooltip-wrapper), and keep `aria-label` for the accessible name.",
};

// The shared primitives that spread their props onto a real DOM node, so a
// `title` passed to them lands as a native tooltip exactly as if it had been
// written on a `<button>`. Hand-maintained on purpose: it is the price of
// letting `title` stay a legitimate prop name elsewhere. Add a component here
// when it starts forwarding `title` to the DOM.
//
// The app's OWN wrappers are deliberately absent: rather than police a `title`
// prop on each of them, they were renamed to take `tooltip` and now own a
// `TooltipWrapper` internally (`StopButtonShell`, `RoleBadge`,
// `PillToggleButton`, `ReferenceChipButton`, `IndicatorSpan`). A prop literally
// named `tooltip` cannot be confused with the native attribute, so those need
// no rule at all.
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

// Every general-purpose app file gets these regardless of the nested-focus-
// boundary allowlist below - overrides that scope out a boundary action must
// still spread this array back in, not drop it by writing a from-scratch
// `no-restricted-syntax` value.
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
];

// ── `no-restricted-syntax` IS COMPOSED FROM DIMENSIONS TOO. ──
//
// Same hazard as the import restrictions above and the same fix - finished here
// rather than designed. `no-restricted-imports` was converted to named
// dimensions (`importRestrictionDimensions`); this rule never followed, and
// every override below hand-rebuilt its array. That is the RESTATEMENT idiom
// the comment at the top of this file says had already deleted a boundary
// twice, and it went on to do it twice more: `src/lib/tab-navigation.ts` and
// the test-file block each dropped SIX families by rebuilding from
// `traycerTypeSafetyRestrictions` alone, and no test could see it.
//
// A block now names what it is EXEMPT from. So a gap is a readable word in a
// list rather than an absence nobody can see, and closing one is deleting that
// word.
//
// The groups PARTITION `generalCustomSyntaxRestrictions` - every entry belongs
// to exactly one group. That is deliberate: it makes "exempt from all of it"
// expressible, so a block that genuinely carries almost nothing (the two above)
// still states its shape instead of opting out by omission.
//
// Identity is by REFERENCE, which is why these name the memoized consts rather
// than rebuilding them: `tabNavigationStoreActionRestrictions([])` called twice
// returns equal-looking objects that are not the same objects, and the filter
// below would silently stop matching.
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
};

/**
 * The base every block carries, plus `general` minus the named exemptions,
 * plus the two allowanced families.
 *
 * All three options are REQUIRED. A caller states its whole shape rather than
 * inheriting a default, because a default is precisely how a block silently
 * stops carrying something. `null` means "this family does not apply here";
 * `[]` means "applies, with no allowances".
 *
 * Passing `tabNavigation` a list implies exemption from the un-allowanced
 * tabNavigation bans - re-adding an allowanced copy while the blanket ban is
 * still present would flag the very calls the allowance names. That coupling
 * was a hand-written `.filter` in four blocks and is now automatic, so it
 * cannot be forgotten in a fifth.
 */
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
      // Dimensions: boundary + kernel. `kernel` rides the BASE block so the
      // ban has no hole outside `src` and none at files the `src` blocks
      // exempt for unrelated reasons (the analytics adapter); the two blocks
      // that lift it - tests and the owner - are narrow and explicit.
      "@typescript-eslint/no-restricted-imports": importRestrictions("kernel"),

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
    // PostHog is reachable only through the typed adapter so every event and
    // property passes its allowlist sanitizer before leaving the app. The
    // adapter's own test is the one other legitimate consumer: it drives the
    // real SDK through the sanitizer to prove the payload boundary.
    files: ["src/**/*.{ts,tsx}"],
    ignores: analyticsAdapterFiles,
    rules: {
      "@typescript-eslint/no-restricted-imports": importRestrictions(
        "posthog",
        "kernel",
      ),
    },
  },
  {
    // D12 read path: ban active-host / default-client hook imports outside the
    // allowlisted layer. The allowlisted files are NOT a subset of this set -
    // they carry boundary + posthog + kernel from the block above, and this
    // block simply never matches them.
    files: ["src/**/*.{ts,tsx}"],
    ignores: [...analyticsAdapterFiles, ...hostSelectionReadAllowlist],
    rules: {
      "@typescript-eslint/no-restricted-imports": importRestrictions(
        "posthog",
        "readPath",
        "kernel",
      ),
    },
  },
  {
    // `src/hooks/epic/**` is inside the read-path allowlist's `src/hooks/**`
    // (the wrapper-hook layer legitimately resolves default clients), but the
    // Epic hooks are mounted by Epic-session surfaces and were where three of
    // PR #1243's per-push findings lived. Re-impose `readPath` there - the
    // full partition, so nothing is dropped - minus the by-caller exemptions,
    // each of which names its app-wide caller above.
    files: ["src/hooks/epic/**/*.{ts,tsx}"],
    ignores: [...testFileGlobs, ...hooksEpicAppWideByCallerExemptions],
    rules: {
      "@typescript-eslint/no-restricted-imports": importRestrictions(
        "posthog",
        "readPath",
        "kernel",
      ),
    },
  },
  {
    // Same re-imposition, for the wrapper-hook directories this round
    // repointed onto caller-supplied clients.
    files: hookDirectoriesRepointedToCallerClients,
    ignores: [...testFileGlobs, ...hookWrapperAppWideReadExemptions],
    rules: {
      "@typescript-eslint/no-restricted-imports": importRestrictions(
        "posthog",
        "readPath",
        "kernel",
      ),
    },
  },
  {
    // The reasoned app-wide reads, per FILE: their partition (boundary +
    // posthog + kernel) minus `readPath`.
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
      ),
    },
  },
  {
    // TESTS LIFT `kernel`, AND ONLY `kernel`. A test may construct a kernel -
    // the StrictMode regression's control arm does exactly that, deliberately,
    // to pin the pre-F2 defect. Tests already sit inside
    // `hostSelectionReadAllowlist`, so their partition is boundary + posthog;
    // naming those two here reproduces it exactly, minus the one being lifted.
    files: testFileGlobs,
    // ...except the adapter's own test: the earlier blocks exempt it via
    // `ignores`, but flat config is last-block-wins, so WITHOUT this ignore
    // the tests block would re-impose `posthog` on the one test whose job is
    // to drive the real SDK through the sanitizer. (Caught by the PR's first
    // full-package lint - scoped runs never visit this file.)
    ignores: analyticsAdapterFiles,
    rules: {
      "@typescript-eslint/no-restricted-imports": importRestrictions("posthog"),
    },
  },
  {
    // The kernel's OWNER lifts `kernel` for itself alone. One file, per the
    // `markdown-anchor.tsx` idiom - a single-file `files` list cannot shadow a
    // broad block by accident, which a directory glob here could.
    files: selectionKernelOwner,
    rules: {
      "@typescript-eslint/no-restricted-imports": importRestrictions("posthog"),
    },
  },
  {
    // D12 write path, upper half: only Settings ▸ Activate and the bridge's
    // composition root may reach the preferred-write API.
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
    // Rendered MARKDOWN, not app chrome. A Markdown link title is written by
    // the document author and belongs on the anchor as `title` - that is the
    // attribute the syntax maps to. Routing it through `TooltipWrapper` would
    // restyle author content as app UI and drop the attribute from the DOM.
    // The ban stays on for every other tooltip in this directory.
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
    // The activation module owns raw tabActivate. Every other caller reaches
    // activateTabIntent, which binds the coordinated layout commit to the
    // history-entry envelope before navigating.
    //
    // The exemption this block exists for is tabActivate and NOTHING ELSE, so
    // the selection bans are restated. Rebuilding the value from
    // `traycerTypeSafetyRestrictions` alone had silently dropped them here:
    // `--print-config` on this file reported 8 restrictions against 71 for an
    // ordinary production module, with no `selectById` entry among them - so
    // the one file allowed to name a tab-activation internal was also the one
    // file allowed to call `selectById`, which nothing intended and no test
    // would have noticed. That is the last-block-wins hazard this config warns
    // about at :30, fired rather than hypothetical.
    //
    // Restated individually rather than by spreading
    // `generalCustomSyntaxRestrictions`, because that array carries the
    // tabNavigation bans this block must not have. Measured: adding these two
    // families produces zero violations here - the file never names either.
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
    // Plan §2/§3 puts source activation inside this reservation-first command.
    // The coordinator may call the two legacy source selectors while its
    // ledger is installed; raw registry.tabActivate remains banned here.
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
    // These kind descriptors implement the source half of tab-navigation's
    // single activation boundary. Keep raw tabActivate restricted here while
    // allowing only the descriptor's own legacy projection action.
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
    // The Epic descriptor owns its canonical route construction and source
    // projection; callers still cannot access raw tabActivate here.
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
    // Test fixtures construct the full router interface and seed stores via
    // setActiveTab / setActiveDraft as part of arrange / act setup, so ONLY
    // those two legacy source actions are allowed here. Raw `tabActivate`
    // access stays banned - tests must activate through activateTabIntent like
    // production, so a raw `tabActivate` call can never lint clean in a test.
    files: ["src/**/__tests__/**/*.{ts,tsx}", "**/__tests__/**/*.{ts,tsx}"],
    rules: {
      // Each remaining exemption is here for a stated reason, and two that were
      // here only by accident are gone. `jsxKey` and `epicTabRoute` were
      // measured across all 1392 test files with the bans restored: ZERO
      // violations either way, so they were never a decision - just collateral
      // from rebuilding this array by hand.
      //
      // `selectById` / `selectionAuthority`: DELIBERATE and load-bearing. The
      // selectors are property-name matches with no call-site distinction, so
      // `expect(mocks.selectById).not.toHaveBeenCalled()` - which PROVES the
      // invariant - is indistinguishable from a violation. Restoring them would
      // redden the assertions that enforce the rule. See the characterization
      // test in `lint-rule-guards.test.ts`, which pins this and pairs
      // it against `tabActivate` presence so a wiped block cannot pass as
      // correct.
      //
      // `nativeTitleTooltip` / `forwardRef`: DELIBERATE. Both bans govern
      // SHIPPED PRODUCT SURFACES, and every occurrence in a test file is a test
      // double imitating a contract it does not own.
      //
      // Censused, not sampled: restoring both surfaces 19 occurrences across 14
      // files, and all 19 are mock scaffolding - 18 inside a `vi.mock` /
      // `vi.hoisted` factory, and the 19th is the `forwardRef` import that feeds
      // one of those factories in the same file.
      //
      // The `forwardRef` ban is React-19 migration debt about OUR components; a
      // double standing in for `react-zoom-pan-pinch` or a Radix item, both of
      // which really do forward a ref, is matching a contract rather than
      // carrying that debt. The `title` ban is about a tooltip a USER hovers,
      // and a mock forwarding `title` to a DOM node so a test can observe it is
      // instrumenting a tooltip, not shipping one.
      //
      // What makes it conclusive rather than arguable: several of those
      // `title={props.title}` lines ARE what the assertions read. Applying the
      // rule literally would edit away the observation the test exists to make.
      // A lint rule that deletes the mechanism of the tests it touches is being
      // applied outside its domain - that is the tell.
      //
      // Not per-line waivers, and the difference from
      // `muted-fill-on-raised-surface-lint.test.ts` is the point: that guard
      // takes waivers because its population is MIXED, so the waiver carries the
      // reason for THAT line. Here the population is uniformly clean, so a
      // waiver on all 19 would carry no information and would train readers to
      // skip waivers that do. Per-line waivers are for mixed populations; a
      // uniform population wants one stated exemption. A selector narrow enough
      // to mean "inside a `vi.mock` callback" is not expressible, and one that
      // tried would be the fails-by-passing shape this file keeps out.
      //
      // Residual, precisely: a component DEFINED in a test file and then
      // imported by product code would escape both bans. That is pathological,
      // would not survive review, and no rule in this file is the right place to
      // catch it. Everything short of it - a mock, a fixture, a harness
      // component - is scaffolding these two bans were never written about.
      "no-restricted-syntax": syntaxRestrictions({
        exempt: [
          "nativeTitleTooltip",
          "forwardRef",
          "selectById",
          "selectionAuthority",
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
    // These hooks build a remote host transport (Architecture §4 / S1's
    // shared `(hostId, userId)` session cache) inside a `useEffect`,
    // deliberately NOT a `useMemo`: only an effect's cleanup is guaranteed to
    // pair with exactly the committed acquire (a `useMemo` factory can run
    // more than once per commit - StrictMode dev double-invoke, or a
    // discarded concurrent render - silently orphaning a live reference on
    // the shared session). This is React's own documented "connecting to an
    // external system" pattern (react.dev/reference/react/useEffect), which
    // this rule's heuristic cannot distinguish from an avoidable
    // derived-state effect.
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
    // Router -> store synchronization direction for an already-committed epic
    // route. This is the inverse of navigateToTabIntent's entry-point seam,
    // so it may read the store action directly while the rest of the app may
    // not.
    files: ["src/routes/epic-tab-route-components.tsx"],
    rules: {
      "no-restricted-syntax": syntaxRestrictions({
        exempt: [],
        nestedFocus: [],
        tabNavigation: ["useEpicCanvasStore.setActiveTab"],
      }),
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
    // Blank-root bootstrap: seeds the first and only tile of a brand-new
    // empty canvas root. There is no prior focus to disambiguate, so there
    // is nothing meaningful to write to the route.
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
      "no-restricted-syntax": syntaxRestrictions({
        exempt: [],
        nestedFocus: ["openTileInBackgroundTab"],
        tabNavigation: null,
      }),
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
      "no-restricted-syntax": syntaxRestrictions({
        exempt: [],
        nestedFocus: ["closeCanvasTab"],
        tabNavigation: null,
      }),
    },
  },
  // Oxlint runs first and owns every compatible rule represented in its
  // generated config, including the type-aware rules. Keep this last so ESLint
  // retains the repository-specific boundaries and selector-based invariants
  // whose implementations and executable guard tests remain ESLint-specific.
  ...oxlint.buildFromOxlintConfigFile(".oxlintrc.json"),
);
