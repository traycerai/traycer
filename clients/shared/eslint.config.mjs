import {
  tseslint,
  globals,
  commonIgnores,
  linterOptionsConfig,
} from "../../eslint/flat-base.mjs";
import { traycerTypeSafetyRestrictions } from "../../eslint/traycer-type-safety-rules.mjs";
import { traycerClientsImportBoundaryRestrictions } from "../../eslint/traycer-clients-import-boundary-rules.mjs";

// Modules the host-lifecycle probe must not reach, by request path.
//
// `**/desktop/**` was a plain omission — the desktop main process owns the
// SMAppService mutators. `**/host-lock/**` closes the *sibling wrapper* gap:
// `clients/shared/host-lock/process-identity.ts` imports `node:child_process`
// at line 1, so importing it would have re-entered spawn territory one hop
// away from a rule that only looked at direct requests. That module is also
// the module a reader is most tempted to reach for (the start-time
// comparator).
//
// There is deliberately no extracted alternative to point at: the
// `process-start-time.ts` leaf that used to serve that role went to the epic's
// `parked-decision-layer` archive along with the rest of the decision layer,
// because nothing in production consumed it. If a probe genuinely needs a
// start-time comparator, restore that leaf from the archive rather than
// reaching through `host-lock` — the ban is on the spawn hop, not the
// arithmetic.
const FORBIDDEN_MODULE_PATH_GROUPS = [
  "**/traycer-cli/**",
  "**/service/platforms/**",
  "**/installer/**",
  "**/host-login-item*",
  "**/desktop/**",
  "**/host-lock/**",
];

const FORBIDDEN_MODULE_MESSAGE =
  "host-lifecycle must not import CLI/desktop mutators or a sibling that spawns; keep the probe read-only.";

const CHILD_PROCESS_MESSAGE =
  "host-lifecycle is read-only: inject ProbeCommandRunner; do not spawn mutators here.";

// `no-restricted-imports` only sees static `import`/`export` declarations.
// A measured sweep found `await import("node:child_process")` and
// `require("node:child_process")` both reported **0 errors** under the rule
// as written, so the boundary was one keyword away from being bypassable.
// These selectors cover the two dynamic forms for the same module set.
// esquery parses `[value=/…/]` by splitting on `/`, so these selector regexes
// must not contain a literal slash — `service/platforms` is matched as
// `platforms`, which is equally specific inside host-lifecycle/**.
const dynamicModuleSource = String.raw`^(node:)?child_process$`;
const forbiddenPathSource = String.raw`(traycer-cli|platforms|installer|host-login-item|desktop|host-lock)`;

const hostLifecycleDynamicImportRestrictions = [
  {
    selector: `ImportExpression > Literal[value=/${dynamicModuleSource}/]`,
    message: CHILD_PROCESS_MESSAGE,
  },
  {
    selector: `CallExpression[callee.name="require"] > Literal[value=/${dynamicModuleSource}/]`,
    message: CHILD_PROCESS_MESSAGE,
  },
  {
    selector: `ImportExpression > Literal[value=/${forbiddenPathSource}/]`,
    message: FORBIDDEN_MODULE_MESSAGE,
  },
  {
    selector: `CallExpression[callee.name="require"] > Literal[value=/${forbiddenPathSource}/]`,
    message: FORBIDDEN_MODULE_MESSAGE,
  },
];

export default tseslint.config(
  { ignores: [...commonIgnores, "dist-sea/**"] },
  linterOptionsConfig,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser, ...globals.es2021 },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "no-restricted-syntax": ["error", ...traycerTypeSafetyRestrictions],
      "@typescript-eslint/no-restricted-imports": [
        "error",
        traycerClientsImportBoundaryRestrictions,
      ],
    },
  },
  // host-lifecycle world probe is read-only by construction (T3). Ban
  // mutation-oriented packages and CLI service controllers so actuators
  // cannot be imported into the probe module by accident.
  {
    files: ["host-lifecycle/**/*.ts"],
    rules: {
      // Flat config replaces a rule's options wholesale rather than merging
      // them, so the package-wide type-safety selectors are re-stated here.
      // Without them, every file under host-lifecycle/** would silently lose
      // `as any` / optional-parameter / default-argument enforcement.
      "no-restricted-syntax": [
        "error",
        ...traycerTypeSafetyRestrictions,
        ...hostLifecycleDynamicImportRestrictions,
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:child_process",
              message: CHILD_PROCESS_MESSAGE,
            },
            {
              name: "child_process",
              message: CHILD_PROCESS_MESSAGE,
            },
          ],
          patterns: [
            {
              group: FORBIDDEN_MODULE_PATH_GROUPS,
              message: FORBIDDEN_MODULE_MESSAGE,
            },
          ],
        },
      ],
    },
  },
  // The real-supervisor suites exist to drive actual launchd / schtasks /
  // systemd, which the platform annexes require and which cannot be done
  // without spawning. The exemption is scoped to those files by name — NOT to
  // `__tests__/**`, because a probe *unit* test reaching for child_process
  // would be a real violation of the rule's intent, and a blanket test
  // exemption would erase exactly what the boundary protects.
  {
    files: ["host-lifecycle/__tests__/real-supervisor-*.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...traycerTypeSafetyRestrictions],
      "no-restricted-imports": "off",
    },
  },
);
