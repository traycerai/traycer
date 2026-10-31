/// <reference types="node" />

import { ESLint, Linter } from "eslint";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

type RestrictedSyntaxRestriction = {
  readonly selector: string;
  readonly message: string;
};

type RestrictionFactory = (
  allowedNames: readonly string[],
) => readonly RestrictedSyntaxRestriction[];

type LintRuleModule = {
  readonly nestedFocusBoundaryRestrictions: RestrictionFactory;
  readonly tabNavigationStoreActionRestrictions: RestrictionFactory;
};

type EslintFileConfig = {
  readonly rules: Readonly<Record<string, unknown>> | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRestriction(value: unknown): value is RestrictedSyntaxRestriction {
  return (
    isRecord(value) &&
    typeof value.selector === "string" &&
    typeof value.message === "string"
  );
}

function readEslintFileConfig(value: unknown): EslintFileConfig {
  if (!isRecord(value)) throw new Error("Expected ESLint file config object");
  const rules = value.rules;
  return { rules: isRecord(rules) ? rules : undefined };
}

function readRestrictionArray(
  value: unknown,
): readonly RestrictedSyntaxRestriction[] {
  const restrictions = Array.isArray(value) ? value : [];
  if (restrictions.every(isRestriction)) return restrictions;
  throw new Error("Expected no-restricted-syntax restriction objects");
}

function readRestrictionFactory(value: unknown): RestrictionFactory {
  if (typeof value !== "function") {
    throw new Error("Expected restriction factory export");
  }
  return (allowedNames) =>
    readRestrictionArray(Reflect.apply(value, undefined, [allowedNames]));
}

function readLintRuleModule(value: unknown): LintRuleModule {
  if (!isRecord(value)) throw new Error("Expected lint rule module object");
  return {
    nestedFocusBoundaryRestrictions: readRestrictionFactory(
      value.nestedFocusBoundaryRestrictions,
    ),
    tabNavigationStoreActionRestrictions: readRestrictionFactory(
      value.tabNavigationStoreActionRestrictions,
    ),
  };
}

const lintRuleModuleUrl = pathToFileURL(
  path.resolve(
    process.cwd(),
    "../../eslint/traycer-nested-focus-boundary-rules.mjs",
  ),
).href;
const importedLintRuleModule: unknown = await import(lintRuleModuleUrl);
const lintRuleModule = readLintRuleModule(importedLintRuleModule);

/**
 * D12/F2 host-selection layer (`eslint/traycer-host-selection-layer-rules.mjs`).
 * Unlike the nested-focus module above, these six families are plain exported
 * arrays/lists, not factories - `selectByIdRestrictions` and
 * `selectionAuthorityRestrictions` need no allowlist parameter because
 * `selectByIdRestrictions` has NO allowlist at all (the write-path allowlist
 * was deleted on purpose - see the module's own doc comment at :84-98) and
 * `selectionAuthorityRestrictions` is gated by file location
 * (`selectionAuthorityWriteAllowlist`), not by a runtime parameter. So this
 * gets its own small reader instead of being forced through
 * `readRestrictionFactory`.
 */
type SelectionLayerRuleModule = {
  readonly selectByIdRestrictions: readonly RestrictedSyntaxRestriction[];
  readonly selectionAuthorityRestrictions: readonly RestrictedSyntaxRestriction[];
  readonly selectionAuthorityWriteAllowlist: readonly string[];
  readonly selectionKernelOwner: readonly string[];
};

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new Error("Expected string array export");
  }
  return value;
}

function readSelectionLayerRuleModule(
  value: unknown,
): SelectionLayerRuleModule {
  if (!isRecord(value)) {
    throw new Error("Expected selection layer rule module object");
  }
  return {
    selectByIdRestrictions: readRestrictionArray(value.selectByIdRestrictions),
    selectionAuthorityRestrictions: readRestrictionArray(
      value.selectionAuthorityRestrictions,
    ),
    selectionAuthorityWriteAllowlist: readStringArray(
      value.selectionAuthorityWriteAllowlist,
    ),
    selectionKernelOwner: readStringArray(value.selectionKernelOwner),
  };
}

const selectionLayerRuleModuleUrl = pathToFileURL(
  path.resolve(
    process.cwd(),
    "../../eslint/traycer-host-selection-layer-rules.mjs",
  ),
).href;
const importedSelectionLayerRuleModule: unknown = await import(
  selectionLayerRuleModuleUrl
);
const selectionLayerRuleModule = readSelectionLayerRuleModule(
  importedSelectionLayerRuleModule,
);

function lint(
  code: string,
  restrictions: readonly RestrictedSyntaxRestriction[],
) {
  const linter = new Linter({ configType: "flat" });
  return linter.verify(
    code,
    {
      languageOptions: { ecmaVersion: "latest", sourceType: "module" },
      rules: {
        "no-restricted-syntax": ["error", ...restrictions],
      },
    },
    { filename: "fixture.js" },
  );
}

describe("nestedFocusBoundaryRestrictions", () => {
  const restrictions = lintRuleModule.nestedFocusBoundaryRestrictions([]);

  it.each([
    {
      name: "direct concise selector pick",
      code: "const closeCanvasTab = useEpicCanvasStore((s) => s.closeCanvasTab);",
    },
    {
      name: "helper-wrapped concise selector pick",
      code: "const closeCanvasTab = useEpicCanvasStore(useShallow((s) => s.closeCanvasTab));",
    },
    {
      name: "block-bodied selector return",
      code: "const closeCanvasTab = useEpicCanvasStore((s) => { return s.closeCanvasTab; });",
    },
    {
      name: "direct getState action call",
      code: 'useEpicCanvasStore.getState().closeCanvasTab("tab-id");',
    },
    {
      name: "literal-computed getState action call",
      code: 'useEpicCanvasStore.getState()["closeCanvasTab"]("tab-id");',
    },
    {
      name: "getState object destructuring",
      code: "const { closeCanvasTab } = useEpicCanvasStore.getState();",
    },
    {
      name: "literal-computed getState object destructuring",
      code: 'const { ["closeCanvasTab"]: closeCanvasTab } = useEpicCanvasStore.getState();',
    },
  ])("flags $name", ({ code }) => {
    expect(lint(code, restrictions)).toHaveLength(1);
  });

  it("allows boundary-backed and unrelated shapes", () => {
    expect(
      lint(
        `
          const prepareCloseCanvasTabFocusTarget = useEpicCanvasStore(
            (s) => s.prepareCloseCanvasTabFocusTarget,
          );
          navigateNested({
            prepare: () => prepareCloseCanvasTabFocusTarget("tab-id"),
          });
          otherStore.getState().closeCanvasTab("tab-id");
          other.closeCanvasTab("tab-id");
          const x = useEpicCanvasStore((s) =>
            otherStore((o) => o.closeCanvasTab),
          );
          useEpicCanvasStore((s) => helper(() => s.closeCanvasTab));
        `,
        restrictions,
      ),
    ).toHaveLength(0);
  });

  it("honors allowed raw action names", () => {
    expect(
      lint(
        `
          const closeCanvasTab = useEpicCanvasStore((s) => {
            return s.closeCanvasTab;
          });
          useEpicCanvasStore.getState()["closeCanvasTab"]("tab-id");
          const { closeCanvasTab: closeTab } = useEpicCanvasStore.getState();
          closeTab("tab-id");
        `,
        lintRuleModule.nestedFocusBoundaryRestrictions(["closeCanvasTab"]),
      ),
    ).toHaveLength(0);
  });
});

describe("tabNavigationStoreActionRestrictions", () => {
  const restrictions = lintRuleModule.tabNavigationStoreActionRestrictions([]);

  it.each([
    {
      name: "epic setActiveTab selector pick",
      code: "const setActiveTab = useEpicCanvasStore((s) => s.setActiveTab);",
    },
    {
      name: "epic setActiveTab getState call",
      code: 'useEpicCanvasStore.getState().setActiveTab("tab-id");',
    },
    {
      name: "epic setActiveTab computed getState call",
      code: 'useEpicCanvasStore.getState()["setActiveTab"]("tab-id");',
    },
    {
      name: "epic setActiveTab destructuring",
      code: "const { setActiveTab } = useEpicCanvasStore.getState();",
    },
    {
      name: "draft setActiveDraft selector pick",
      code: "const setActiveDraft = useLandingDraftStore((s) => s.setActiveDraft);",
    },
    {
      name: "draft setActiveDraft getState call",
      code: 'useLandingDraftStore.getState().setActiveDraft("draft-id");',
    },
  ])("flags $name", ({ code }) => {
    expect(lint(code, restrictions)).toHaveLength(1);
  });

  it("allows unrelated receivers with the same action names", () => {
    expect(
      lint(
        `
          useRateLimitPopoverStore.getState().setActiveTab("codex");
          notificationTabs.setActiveTab("unread");
          other.getState().setActiveDraft("draft-id");
        `,
        restrictions,
      ),
    ).toHaveLength(0);
  });

  it("honors allowed store/action names", () => {
    expect(
      lint(
        `
          const setActiveTab = useEpicCanvasStore((s) => s.setActiveTab);
          useEpicCanvasStore.getState().setActiveTab("tab-id");
          useLandingDraftStore.getState().setActiveDraft("draft-id");
        `,
        lintRuleModule.tabNavigationStoreActionRestrictions([
          "useEpicCanvasStore.setActiveTab",
        ]),
      ),
    ).toHaveLength(1);
  });

  it.each([
    {
      name: "named import of tabActivate",
      code: "import { tabActivate } from '@/stores/tabs/registry';",
    },
    {
      name: "direct member access of tabActivate",
      code: "const activate = registry.tabActivate;",
    },
    {
      name: "computed member access of tabActivate",
      code: 'const activate = registry["tabActivate"];',
    },
    {
      name: "destructured alias of tabActivate",
      code: "const { tabActivate: activate } = registry;",
    },
    {
      name: "literal-computed destructured alias of tabActivate",
      code: 'const { ["tabActivate"]: activate } = registry;',
    },
    {
      // Cold review #10: no-substitution template literal is NOT a Literal node.
      name: "template-computed member access of tabActivate",
      code: "const activate = registry[`tabActivate`];",
    },
    {
      // Cold review #10: assignment destructuring is an AssignmentExpression,
      // not a VariableDeclarator, so it bypassed the declaration selectors.
      name: "assignment-destructured shorthand of tabActivate",
      code: "let activate; ({ tabActivate: activate } = registry);",
    },
    {
      name: "assignment-destructured alias of tabActivate",
      code: "let a; ({ tabActivate: a } = registry);",
    },
    {
      name: "raw activation plus route navigation pair",
      code: `
        import { tabActivate } from '@/stores/tabs/registry';
        tabActivate(intent);
        navigate({ to: '/epics' });
      `,
    },
  ])("flags raw $name outside the activation seam", ({ code }) => {
    expect(lint(code, restrictions).length).toBeGreaterThanOrEqual(1);
  });

  it.each([
    {
      name: "quoted named import of tabActivate",
      code: "import { \"tabActivate\" as activate } from '@/stores/tabs/registry';",
    },
    {
      name: "template-key destructured alias of tabActivate (declaration)",
      code: "const { [`tabActivate`]: activate } = registry;",
    },
    {
      name: "template-key destructured alias of tabActivate (assignment)",
      code: "let activate; ({ [`tabActivate`]: activate } = registry);",
    },
    {
      name: "parameter-destructured tabActivate",
      code: "function useIt({ tabActivate }) { tabActivate(); }",
    },
  ])("flags raw $name outside the activation seam", ({ code }) => {
    expect(lint(code, restrictions).length).toBeGreaterThanOrEqual(1);
  });

  it("allows activateTabIntent as the public seam name", () => {
    expect(
      lint(
        `
          import { activateTabIntent } from '@/lib/tab-navigation';
          activateTabIntent(navigate, intent, undefined);
        `,
        restrictions,
      ),
    ).toHaveLength(0);
  });
});

/**
 * D12 write path, lower half: `selectById` has NO allowlist (see the rules
 * module's doc comment at :84-98) - every shape must flag with zero
 * conditions, unlike `nestedFocusBoundaryRestrictions`/
 * `tabNavigationStoreActionRestrictions` above, which both take an allowlist
 * parameter.
 */
describe("selectByIdRestrictions", () => {
  const restrictions = selectionLayerRuleModule.selectByIdRestrictions;

  it.each([
    {
      name: "named import",
      code: 'import { selectById } from "@/lib/host/directory";\nvoid selectById;\n',
    },
    {
      name: "quoted named import",
      code: 'import { "selectById" as pick } from "@/lib/host/directory";\nvoid pick;\n',
    },
    {
      name: "plain member access",
      code: "directoryService.selectById(hostId);",
    },
    {
      name: "computed literal member access",
      code: 'directoryService["selectById"](hostId);',
    },
    {
      name: "computed template member access",
      code: "directoryService[`selectById`](hostId);",
    },
    {
      name: "destructure identifier",
      code: "const { selectById } = directoryService;\nvoid selectById;\n",
    },
    {
      name: "destructure literal key",
      code: 'const { "selectById": pick } = directoryService;\nvoid pick;\n',
    },
    {
      name: "destructure template key",
      code: "const { [`selectById`]: pick } = directoryService;\nvoid pick;\n",
    },
  ])("flags $name", ({ code }) => {
    expect(lint(code, restrictions)).toHaveLength(1);
  });

  it("does not flag near-miss shapes with a different property name", () => {
    // Negative control for a receiver-agnostic total ban: since none of the
    // selectors above check the receiver (there is no allowlist to gate on),
    // the meaningful false-positive risk is substring/name confusion, not an
    // unrelated receiver. This proves exact-name matching, not prefix/suffix.
    expect(
      lint(
        `
          directoryService.selectByIdentifier(hostId);
          directoryService.oldSelectById(hostId);
          const other = { selectById: 1 };
          other.notSelectById(hostId);
          import { selectByIdFactory } from "@/lib/host/factory";
          void other;
          void selectByIdFactory;
        `,
        restrictions,
      ),
    ).toHaveLength(0);
  });
});

/**
 * D12 write path, upper half: `selectionAuthority` is banned except for the
 * two files in `selectionAuthorityWriteAllowlist`, enforced at the config
 * layer (below), not by a runtime allowlist parameter here.
 */
describe("selectionAuthorityRestrictions", () => {
  const restrictions = selectionLayerRuleModule.selectionAuthorityRestrictions;

  it.each([
    {
      name: "plain member access",
      code: "runnerHost.selectionAuthority.activate(hostId);",
    },
    {
      name: "computed literal member access",
      code: 'runnerHost["selectionAuthority"].activate(hostId);',
    },
    {
      name: "computed template member access",
      code: "runnerHost[`selectionAuthority`].activate(hostId);",
    },
    {
      name: "destructure identifier",
      code: "const { selectionAuthority } = runnerHost;\nvoid selectionAuthority;\n",
    },
    {
      name: "destructure literal key",
      code: 'const { "selectionAuthority": authority } = runnerHost;\nvoid authority;\n',
    },
    {
      name: "destructure template key",
      code: "const { [`selectionAuthority`]: authority } = runnerHost;\nvoid authority;\n",
    },
  ])("flags $name", ({ code }) => {
    expect(lint(code, restrictions)).toHaveLength(1);
  });

  it("does not flag near-miss shapes with a different property name", () => {
    expect(
      lint(
        `
          runnerHost.selectionAuthorityLegacy;
          const { authority } = runnerHost;
          other.selectionAuthority2;
          void authority;
        `,
        restrictions,
      ),
    ).toHaveLength(0);
  });
});

/**
 * Cold review #10: production flat-config overrides that rewrite
 * `no-restricted-syntax` must keep raw `tabActivate` restricted except for
 * the sole allowed activation module (`src/lib/tab-navigation.ts`).
 */
describe("eslint config retains raw tabActivate restriction", () => {
  const guiAppRoot = path.resolve(process.cwd());

  function configMentionsTabActivate(ruleValue: unknown): boolean {
    if (!Array.isArray(ruleValue)) return false;
    return ruleValue.some((entry) => {
      if (typeof entry === "string" || typeof entry === "number") return false;
      if (!isRecord(entry)) return false;
      const selector = typeof entry.selector === "string" ? entry.selector : "";
      const message = typeof entry.message === "string" ? entry.message : "";
      return (
        selector.includes("tabActivate") || message.includes("tabActivate")
      );
    });
  }

  async function fileHasTabActivateRestriction(
    relativePath: string,
  ): Promise<boolean> {
    const eslint = new ESLint({ cwd: guiAppRoot });
    const config = readEslintFileConfig(
      await eslint.calculateConfigForFile(path.join(guiAppRoot, relativePath)),
    );
    return configMentionsTabActivate(config.rules?.["no-restricted-syntax"]);
  }

  const productionOverridesThatMustRetain = [
    "src/lib/routes.ts",
    "src/stores/epics/canvas/store.ts",
    "src/stores/home/landing-draft-store.ts",
    "src/stores/tabs/kinds/draft.tsx",
    "src/stores/tabs/kinds/epic.tsx",
    "src/stores/tabs/kinds/history.tsx",
    "src/stores/tabs/kinds/settings.tsx",
  ] as const;

  it.each(productionOverridesThatMustRetain.map((file) => ({ file })))(
    "retains tabActivate restriction for $file",
    async ({ file }) => {
      expect(await fileHasTabActivateRestriction(file)).toBe(true);
    },
  );

  it("allows tab-navigation.ts to omit the raw tabActivate restriction", async () => {
    expect(
      await fileHasTabActivateRestriction("src/lib/tab-navigation.ts"),
    ).toBe(false);
  });

  it("keeps the restriction on ordinary production modules", async () => {
    expect(
      await fileHasTabActivateRestriction(
        "src/lib/commands/actions/new-epic.ts",
      ),
    ).toBe(true);
  });

  it("keeps the raw tabActivate restriction in test files", async () => {
    // Cold review #10: the test override previously dropped the whole
    // restriction, so a raw tabActivate import lint clean in a test. Tests may
    // seed setActiveTab/setActiveDraft, but must still route activation through
    // activateTabIntent - so the tabActivate restriction stays.
    expect(
      await fileHasTabActivateRestriction(
        "src/lib/tab-navigation/__tests__/navigation-envelope.test.ts",
      ),
    ).toBe(true);
  });
});

/**
 * F10: the config-mention tests above only prove the config MENTIONS
 * tabActivate for a given file path. These probe the bypass forms THROUGH
 * THE REAL flat config end-to-end via `ESLint#lintText`, which actually
 * parses and runs every configured rule (not just `no-restricted-syntax`)
 * against the exact production `eslint.config.mjs` - for both a production
 * file path and a test file path - so a caught violation here proves the
 * real config catches the bypass, not just that a matching selector object
 * exists somewhere in the rule array.
 */
describe("eslint config actually catches tabActivate bypass forms (lintText)", () => {
  const guiAppRoot = path.resolve(process.cwd());
  // Real on-disk files. `lintText`'s `code` argument - not the file's actual
  // disk content - is what gets linted, but typed linting
  // (`parserOptions.projectService`) requires the path to resolve to an
  // actual project-tracked file, so these must be real paths that exist.
  const PRODUCTION_FILE_PATH = "src/lib/routes.ts";
  const TEST_FILE_PATH = "src/lib/__tests__/analytics.test.ts";

  // Asserted up front so a renamed or deleted anchor fails as "this file no
  // longer exists" rather than as an opaque project-resolution error from deep
  // inside `projectService`, which reads like a broken lint config.
  it.each([PRODUCTION_FILE_PATH, TEST_FILE_PATH])(
    "anchors lintText on %s, which must exist on disk",
    (relativePath) => {
      expect(existsSync(path.join(guiAppRoot, relativePath))).toBe(true);
    },
  );

  function tabActivateRestrictedSyntaxMessages(
    messages: readonly Linter.LintMessage[],
  ): readonly Linter.LintMessage[] {
    return messages.filter(
      (message) =>
        message.ruleId === "no-restricted-syntax" &&
        message.message.includes("tabActivate"),
    );
  }

  async function lintBypassAt(
    code: string,
    relativePath: string,
  ): Promise<readonly Linter.LintMessage[]> {
    const eslint = new ESLint({ cwd: guiAppRoot });
    const results = await eslint.lintText(code, {
      filePath: path.join(guiAppRoot, relativePath),
    });
    const result = results[0];
    expect(result, `expected a lint result for ${relativePath}`).toBeDefined();
    return result.messages;
  }

  const bypassForms = [
    {
      name: "quoted named import",
      code: 'import { "tabActivate" as activate } from "@/stores/tabs/registry";\nvoid activate;\n',
    },
    {
      name: "string-key computed member",
      code: 'const registry = { tabActivate: () => {} };\nregistry["tabActivate"]();\n',
    },
    {
      name: "template-key computed member",
      code: "const registry = { tabActivate: () => {} };\nregistry[`tabActivate`]();\n",
    },
    {
      name: "template-key declaration destructuring",
      code: "const registry = { tabActivate: () => {} };\nconst { [`tabActivate`]: activate } = registry;\nvoid activate;\n",
    },
    {
      name: "template-key assignment destructuring",
      code: "const registry = { tabActivate: () => {} };\nlet activate;\n({ [`tabActivate`]: activate } = registry);\nvoid activate;\n",
    },
    {
      name: "parameter destructuring",
      code: "function useIt({ tabActivate }) {\n  tabActivate();\n}\nuseIt({ tabActivate: () => {} });\n",
    },
  ] as const;

  const fileTargets = [
    { label: "a production file", path: PRODUCTION_FILE_PATH },
    { label: "a test file", path: TEST_FILE_PATH },
  ] as const;

  it.each(
    bypassForms.flatMap((form) =>
      fileTargets.map((target) => ({
        formName: form.name,
        code: form.code,
        targetLabel: target.label,
        targetPath: target.path,
      })),
    ),
  )(
    "catches $formName through the real config for $targetLabel",
    async ({ code, targetPath }) => {
      const messages = await lintBypassAt(code, targetPath);
      expect(
        tabActivateRestrictedSyntaxMessages(messages).length,
      ).toBeGreaterThanOrEqual(1);
    },
  );

  it("CONTROL: the real config does not flag legitimate activateTabIntent usage as a tabActivate bypass", async () => {
    const messages = await lintBypassAt(
      [
        'import { activateTabIntent } from "@/lib/tab-navigation";',
        'import { settingsTabIntent } from "@/lib/tab-navigation/intents";',
        "declare const navigateFn: Parameters<typeof activateTabIntent>[0];",
        'activateTabIntent(navigateFn, settingsTabIntent("general"), undefined);',
        "",
      ].join("\n"),
      PRODUCTION_FILE_PATH,
    );
    expect(tabActivateRestrictedSyntaxMessages(messages)).toHaveLength(0);
  });
});

/**
 * D12/F2 host-selection layer, Layer 2: the config-mention sweep. This is the
 * layer that catches the hazard documented at `eslint.config.mjs:30-48` -
 * flat config REPLACES a rule's options rather than merging them, so the LAST
 * block matching a file supplies that file's entire `no-restricted-syntax`
 * value, and a from-scratch appended block silently switches every earlier
 * restriction off. Measured on this tree: one appended block dropped
 * `no-restricted-syntax` from 71 entries (including `selectById`) to 1.
 *
 * `eslint.config.mjs` has thirteen blocks that assign `no-restricted-syntax`.
 * One row below per block, each anchored to a real on-disk file that block
 * actually matches - breadth across override blocks is the point, since that
 * is where the hazard lives, not depth on any one file.
 */
const guiAppRoot = path.resolve(process.cwd());

function configRuleValueMentions(ruleValue: unknown, needle: string): boolean {
  if (!Array.isArray(ruleValue)) return false;
  return ruleValue.some((entry) => {
    if (typeof entry === "string" || typeof entry === "number") return false;
    if (!isRecord(entry)) return false;
    const selector = typeof entry.selector === "string" ? entry.selector : "";
    const message = typeof entry.message === "string" ? entry.message : "";
    return selector.includes(needle) || message.includes(needle);
  });
}

function restrictedImportPatternsMention(
  ruleValue: unknown,
  needle: string,
): boolean {
  if (!Array.isArray(ruleValue)) return false;
  // Annotated `unknown` deliberately: `Array.isArray` on an `unknown` narrows
  // to `any[]`, so an unannotated `ruleValue[1]` is an `any` assignment, which
  // this package's lint rejects. `isRecord` below is what actually narrows it.
  const options: unknown = ruleValue[1];
  if (!isRecord(options) || !Array.isArray(options.patterns)) return false;
  return options.patterns.some((pattern: unknown) => {
    if (!isRecord(pattern)) return false;
    const importNames = Array.isArray(pattern.importNames)
      ? pattern.importNames
      : [];
    const group = Array.isArray(pattern.group) ? pattern.group : [];
    return (
      importNames.includes(needle) ||
      group.some((entry) => typeof entry === "string" && entry.includes(needle))
    );
  });
}

async function calculatedRulesFor(
  relativePath: string,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  const eslint = new ESLint({ cwd: guiAppRoot });
  const config = readEslintFileConfig(
    await eslint.calculateConfigForFile(path.join(guiAppRoot, relativePath)),
  );
  return config.rules;
}

async function fileHasSelectByIdRestriction(
  relativePath: string,
): Promise<boolean> {
  const rules = await calculatedRulesFor(relativePath);
  return configRuleValueMentions(rules?.["no-restricted-syntax"], "selectById");
}

async function fileHasSelectionAuthorityRestriction(
  relativePath: string,
): Promise<boolean> {
  const rules = await calculatedRulesFor(relativePath);
  return configRuleValueMentions(
    rules?.["no-restricted-syntax"],
    "selectionAuthority",
  );
}

async function fileHasKernelImportRestriction(
  relativePath: string,
): Promise<boolean> {
  const rules = await calculatedRulesFor(relativePath);
  return restrictedImportPatternsMention(
    rules?.["@typescript-eslint/no-restricted-imports"],
    "SelectionEvidenceKernel",
  );
}

async function fileHasReadPathImportRestriction(
  relativePath: string,
): Promise<boolean> {
  const rules = await calculatedRulesFor(relativePath);
  return restrictedImportPatternsMention(
    rules?.["@typescript-eslint/no-restricted-imports"],
    "useAddressableHostId",
  );
}

/**
 * The derived-host read joined the `readPath` dimension in PR #1243; a file
 * that carries the dimension carries all of it. Checked by its OWN name so a
 * regression that drops only this pattern (the dimension is a hand-written
 * list) reads as a red here, not as green-by-neighbour.
 */
async function fileHasEffectiveHostReadRestriction(
  relativePath: string,
): Promise<boolean> {
  const rules = await calculatedRulesFor(relativePath);
  return restrictedImportPatternsMention(
    rules?.["@typescript-eslint/no-restricted-imports"],
    "useEffectiveHostId",
  );
}

describe("eslint config retains selectById across every no-restricted-syntax override block", () => {
  // One real file per block that rewrites `no-restricted-syntax`
  // (`eslint.config.mjs`, grep the rule name): the general base block, both
  // `selectionAuthorityWriteAllowlist` files, `markdown-anchor.tsx`,
  // `tab-navigation.ts` (see the fix at :429-457 - this row is what would
  // have caught that gap), `tab-command-coordinator.ts`, the two tab `kinds/`
  // descriptors, `epic-tab-route-components.tsx`, and the four
  // nested-focus-boundary overrides. The test-files block is deliberately
  // NOT in this table - see the characterization describe below.
  const overrideBlockAnchors = [
    "src/lib/registries/epic-session-registry.ts",
    "src/components/settings/host-scope/use-host-scope.ts",
    "src/providers/host-runtime-provider.tsx",
    "src/markdown/components/markdown-anchor.tsx",
    "src/lib/tab-navigation.ts",
    "src/stores/tabs/tab-command-coordinator.ts",
    "src/stores/tabs/kinds/draft.tsx",
    "src/stores/tabs/kinds/epic.tsx",
    "src/routes/epic-tab-route-components.tsx",
    "src/components/epic-canvas/hooks/use-epic-route-synchronization.ts",
    "src/components/epic-canvas/canvas/tile-canvas.tsx",
    "src/hooks/worktree/use-register-setup-terminal-tabs-from-binding.ts",
    "src/components/epic-canvas/sidebar/epic-sidebar.tsx",
  ] as const;

  it.each(overrideBlockAnchors.map((file) => ({ file })))(
    "anchors on $file, which must exist on disk",
    ({ file }) => {
      expect(existsSync(path.join(guiAppRoot, file))).toBe(true);
    },
  );

  it.each(overrideBlockAnchors.map((file) => ({ file })))(
    "retains the selectById restriction for $file",
    async ({ file }) => {
      expect(await fileHasSelectByIdRestriction(file)).toBe(true);
    },
  );
});

describe("eslint config gates selectionAuthority to its write allowlist", () => {
  const ORDINARY_FILE = "src/lib/registries/epic-session-registry.ts";
  const WRITE_ALLOWLIST_FILES =
    selectionLayerRuleModule.selectionAuthorityWriteAllowlist;

  it("keeps selectionAuthority restricted on an ordinary production file", async () => {
    expect(await fileHasSelectionAuthorityRestriction(ORDINARY_FILE)).toBe(
      true,
    );
  });

  it.each(WRITE_ALLOWLIST_FILES.map((file) => ({ file })))(
    "lifts selectionAuthority for allowlisted writer $file",
    async ({ file }) => {
      expect(await fileHasSelectionAuthorityRestriction(file)).toBe(false);
    },
  );

  it.each(WRITE_ALLOWLIST_FILES.map((file) => ({ file })))(
    "POSITIVE: $file still carries selectById, proving the lift is selective, not a wholesale drop",
    async ({ file }) => {
      // Without this pairing, a block that dropped ALL selection-layer
      // restrictions for these two files (not just selectionAuthority) would
      // still pass the "absent" assertion above - the exemption working would
      // be indistinguishable from the whole guard being disabled here.
      expect(await fileHasSelectByIdRestriction(file)).toBe(true);
    },
  );
});

function singleEntry(list: readonly string[]): string {
  if (list.length !== 1) {
    throw new Error(`Expected exactly one entry, got ${list.length}`);
  }
  const [entry] = list;
  return entry;
}

describe("eslint config gates the kernel import restriction to its owner", () => {
  const ORDINARY_FILE = "src/lib/registries/epic-session-registry.ts";
  const KERNEL_OWNER = singleEntry(
    selectionLayerRuleModule.selectionKernelOwner,
  );

  it("keeps the kernel import restricted on an ordinary production file", async () => {
    expect(await fileHasKernelImportRestriction(ORDINARY_FILE)).toBe(true);
  });

  it("lifts the kernel import restriction for the owner", async () => {
    expect(await fileHasKernelImportRestriction(KERNEL_OWNER)).toBe(false);
  });

  it("POSITIVE: the owner still carries selectById, proving the lift is selective", async () => {
    expect(await fileHasSelectByIdRestriction(KERNEL_OWNER)).toBe(true);
  });
});

describe("eslint config gates the read-path import restriction to its allowlist", () => {
  // Deliberately outside `hostSelectionReadAllowlist`: ordinary tab-content
  // trees under src/components/chat/ carry no directory-level exemption.
  const TAB_CONTENT_FILE = "src/components/chat/agent-stop-button.tsx";
  // Inside the allowlist: app chrome under `src/components/layout/**`.
  const ALLOWLISTED_FILE = "src/components/layout/host-ready-gate.tsx";

  it.each([TAB_CONTENT_FILE, ALLOWLISTED_FILE])(
    "anchors on %s, which must exist on disk",
    (file) => {
      expect(existsSync(path.join(guiAppRoot, file))).toBe(true);
    },
  );

  it("restricts the read-path import for tab-content outside the allowlist", async () => {
    expect(await fileHasReadPathImportRestriction(TAB_CONTENT_FILE)).toBe(true);
  });

  it("lifts the read-path import restriction inside an allowlisted directory", async () => {
    expect(await fileHasReadPathImportRestriction(ALLOWLISTED_FILE)).toBe(
      false,
    );
  });

  it("the dimension bans the DERIVED host read too, by name", async () => {
    expect(await fileHasEffectiveHostReadRestriction(TAB_CONTENT_FILE)).toBe(
      true,
    );
  });
});

/**
 * PR #1243: the Epic canvas subtree and `src/hooks/epic/**` were carved OUT
 * of the read-path allowlist as "app chrome" - the two-role model the redesign
 * replaced with three (D15). Those surfaces read the Epic SESSION's host, and
 * exempting the directories let ~40 app-wide reads accumulate there and
 * surface as one review finding per push, three rounds running. These anchors
 * pin that the subtree now carries `readPath`, that the reasoned exceptions
 * are lifted per FILE and only `readPath` is lifted (the file still carries
 * `kernel`, proving the lift is selective), and that the real config flags the
 * import at a sidebar path by rule name - the positive control for "clean".
 */
describe("eslint config fences the Epic canvas subtree and hooks/epic behind readPath (PR #1243)", () => {
  const SIDEBAR_FILE = "src/components/epic-canvas/sidebar/epic-sidebar.tsx";
  const SHARING_PANEL_FILE =
    "src/components/epic-canvas/panels/epic-sharing/panel.tsx";
  const RENDERER_FILE = "src/components/epic-canvas/renderers/chat-tile.tsx";
  const SESSION_HOOK_FILE = "src/hooks/epic/use-epic-collaborator-mutations.ts";
  // Exempt per FILE, with a reason: mounted only from the epics list.
  const BY_CALLER_EXEMPT_HOOK =
    "src/hooks/epic/use-epic-batch-delete-mutation.ts";
  // Exempt per FILE, with a reason: the canvas host hook's own fallback.
  const CANVAS_HOST_HOOK =
    "src/components/epic-canvas/hooks/use-canvas-host-id.ts";
  // NOT exempt, and a sibling of an exempt file - a directory glob would have
  // covered it; a file list does not.
  const SIBLING_OF_EXEMPT_HOOK =
    "src/hooks/epic/use-epic-tui-agent-mutations.ts";
  // The selector surface over the Epic session's handle: allowlisted as
  // "canvas-serving, not tab-pinned" (the two-role premise) until round 6,
  // where its one app-wide read stamped every projected record with the
  // wrong host during a re-point. The census had excluded `src/lib/`.
  const EPIC_SELECTORS_FILE = "src/lib/epic-selectors.ts";

  it.each([
    SIDEBAR_FILE,
    SHARING_PANEL_FILE,
    RENDERER_FILE,
    SESSION_HOOK_FILE,
    BY_CALLER_EXEMPT_HOOK,
    CANVAS_HOST_HOOK,
    SIBLING_OF_EXEMPT_HOOK,
    EPIC_SELECTORS_FILE,
  ])("anchors on %s, which must exist on disk", (file) => {
    expect(existsSync(path.join(guiAppRoot, file))).toBe(true);
  });

  it.each([
    SIDEBAR_FILE,
    SHARING_PANEL_FILE,
    RENDERER_FILE,
    EPIC_SELECTORS_FILE,
  ])(
    "restricts the app-wide reads at %s (was allowlisted as app chrome / canvas-serving)",
    async (file) => {
      expect(await fileHasReadPathImportRestriction(file)).toBe(true);
      expect(await fileHasEffectiveHostReadRestriction(file)).toBe(true);
    },
  );

  it.each([SESSION_HOOK_FILE, SIBLING_OF_EXEMPT_HOOK])(
    "restricts the app-wide reads at %s (hooks/epic re-imposes readPath)",
    async (file) => {
      expect(await fileHasReadPathImportRestriction(file)).toBe(true);
    },
  );

  it.each([BY_CALLER_EXEMPT_HOOK, CANVAS_HOST_HOOK])(
    "lifts readPath, and ONLY readPath, for the reasoned exemption %s",
    async (file) => {
      expect(await fileHasReadPathImportRestriction(file)).toBe(false);
      expect(await fileHasEffectiveHostReadRestriction(file)).toBe(false);
      // POSITIVE: the file still carries the rest of its partition.
      expect(await fileHasKernelImportRestriction(file)).toBe(true);
    },
  );

  // The hook-INDIRECTION half (round 6): `readPath` only ever sees a file's
  // own imports, so a wrapper hook that resolved `useHostClient()` on behalf
  // of an Epic surface laundered the read past the fence. Those directories
  // now take the caller's client and carry `readPath` themselves.
  const REPOINTED_HOOK_FILE = "src/hooks/comments/use-epic-comment-threads.ts";
  const REPOINTED_HOOK_SIBLING =
    "src/hooks/snapshots/use-snapshot-diff-query.ts";
  // Exempt per FILE, with a reason: the app-wide wrapper kept for the
  // following surface (`open-in-editor-button.tsx`).
  const WRAPPER_EXEMPT_HOOK = "src/hooks/editor/use-editor-open-mutation.ts";

  it.each([REPOINTED_HOOK_FILE, REPOINTED_HOOK_SIBLING, WRAPPER_EXEMPT_HOOK])(
    "anchors on %s, which must exist on disk",
    (file) => {
      expect(existsSync(path.join(guiAppRoot, file))).toBe(true);
    },
  );

  it.each([REPOINTED_HOOK_FILE, REPOINTED_HOOK_SIBLING])(
    "restricts the app-wide reads at %s (wrapper hooks re-impose readPath)",
    async (file) => {
      expect(await fileHasReadPathImportRestriction(file)).toBe(true);
      expect(await fileHasEffectiveHostReadRestriction(file)).toBe(true);
    },
  );

  it("lifts readPath, and ONLY readPath, for the reasoned wrapper exemption", async () => {
    expect(await fileHasReadPathImportRestriction(WRAPPER_EXEMPT_HOOK)).toBe(
      false,
    );
    expect(await fileHasEffectiveHostReadRestriction(WRAPPER_EXEMPT_HOOK)).toBe(
      false,
    );
    // POSITIVE: the file still carries the rest of its partition.
    expect(await fileHasKernelImportRestriction(WRAPPER_EXEMPT_HOOK)).toBe(
      true,
    );
  });

  it("POSITIVE CONTROL: the real config flags an app-wide read at a repointed wrapper-hook path, by rule name", async () => {
    const eslint = new ESLint({ cwd: guiAppRoot });
    const code =
      'import { useHostClient } from "@/lib/host";\nvoid useHostClient;\n';
    const results = await eslint.lintText(code, {
      filePath: path.join(guiAppRoot, REPOINTED_HOOK_FILE),
    });
    const messages = results[0]?.messages ?? [];
    expect(
      messages.filter(
        (message) =>
          message.ruleId === "@typescript-eslint/no-restricted-imports",
      ),
    ).toHaveLength(1);
  });

  it("POSITIVE CONTROL: the real config flags an app-wide read at a sidebar path, by rule name", async () => {
    const eslint = new ESLint({ cwd: guiAppRoot });
    const code =
      'import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";\nvoid useEffectiveHostId;\n';
    const results = await eslint.lintText(code, {
      filePath: path.join(guiAppRoot, SIDEBAR_FILE),
    });
    const messages = results[0]?.messages ?? [];
    expect(
      messages.filter(
        (message) =>
          message.ruleId === "@typescript-eslint/no-restricted-imports",
      ),
    ).toHaveLength(1);
  });
});

/**
 * The test-files override block (`files: testFileGlobs`) does NOT restate
 * `selectById`/`selectionAuthority`. This is a DELIBERATE, reasoned exemption,
 * not an oversight like the `tab-navigation.ts` gap fixed above - confirmed
 * with the coordinator. The AST selectors are pure property-name matches with
 * no call-site distinction, so `expect(mocks.selectById).not.toHaveBeenCalled()`
 * (which PROVES the invariant) is indistinguishable from an actual violation
 * to the selector. At least 15 test files assert `selectById` is never
 * called; restoring the ban here would redden those correct assertions and
 * pressure someone into deleting the very tests that enforce this rule.
 *
 * This file - `lint-rule-guards.test.ts` itself - matches `testFileGlobs`
 * too, so the guard suite you are reading runs under the exemption it
 * documents here.
 *
 * The residual risk this leaves open: a test could call the real
 * `selectById`/`selectionAuthority` and lint clean. That risk is accepted,
 * not eliminated - this describe makes it visible instead of silent.
 *
 * A narrower selector that could eventually let tests carry the ban -
 * `CallExpression[callee.property.name='selectById']` - would separate the
 * assertion from the violation: a bare `mocks.selectById` reference (the
 * assertion) is not a callee, so it would stop matching, while
 * `mocks.selectById(hostId)` (the violation) still would. It is NOT
 * sufficient on its own, though: it misses the indirection
 * `const f = x.selectById; f();`, where the call site never names
 * `selectById` at all. Recorded here so the next person doesn't re-derive
 * this and stop at the first, incomplete version.
 *
 * The pairing below is what keeps this test honest: asserting ONLY that
 * `selectById` is absent would still pass if some future block wiped every
 * restriction for test files (not just the two selection ones) - `tabActivate`
 * staying present is independent proof the block still composes at all.
 */
describe("eslint config: test-files block deliberately exempts selectById (characterization, not a regression)", () => {
  const TEST_FILE = "src/__tests__/lint-rule-guards.test.ts";

  // This anchor is load-bearing, not a courtesy check, and the rename that
  // produced this comment is the proof: `calculateConfigForFile` resolves a
  // path by GLOB, so it answers happily for a file that does not exist. With
  // the file renamed and this constant left stale, the two arms below both
  // PASSED - they were characterizing a phantom - and this assertion was the
  // only one that failed. Delete it as redundant and those two go vacuous
  // silently.
  it("anchors on this file, which must exist on disk", () => {
    expect(existsSync(path.join(guiAppRoot, TEST_FILE))).toBe(true);
  });

  it("CHARACTERIZATION: test files do not carry the selectById restriction", async () => {
    expect(await fileHasSelectByIdRestriction(TEST_FILE)).toBe(false);
  });

  it("still carries the tabActivate restriction, proving the block still composes at all", async () => {
    const rules = await calculatedRulesFor(TEST_FILE);
    expect(
      configRuleValueMentions(rules?.["no-restricted-syntax"], "tabActivate"),
    ).toBe(true);
  });

  // Two families that were in the exemption list only as collateral from
  // rebuilding the array by hand, not as decisions. Measured across all 1392
  // test files with the bans restored: ZERO violations either way. Closed, and
  // pinned here so the closure cannot quietly come undone the way the original
  // drop did - which nothing noticed because nothing asserted it.
  it.each([
    { family: "jsxKey", needle: "nullish-coalescing fallbacks" },
    { family: "epicTabRoute", needle: "epicTabRoute" },
  ])(
    "carries the $family ban, closed after measuring zero violations",
    async ({ needle }) => {
      const rules = await calculatedRulesFor(TEST_FILE);
      expect(
        configRuleValueMentions(rules?.["no-restricted-syntax"], needle),
      ).toBe(true);
    },
  );
});

/**
 * Layer 2, end-to-end: the config-mention tests above only prove a matching
 * selector object exists somewhere in the array for a given file.
 * `ESLint#lintText` against the real `eslint.config.mjs` proves the rule
 * actually FIRES. Production paths only - the test-files exemption above
 * means a `selectById` bypass in a test path legitimately lints clean today,
 * so asserting it gets caught there would be asserting something false.
 */
describe("eslint config actually catches selectById bypass forms (lintText)", () => {
  const SELECTION_PRODUCTION_FILE_PATH = "src/lib/routes.ts";

  it("anchors lintText on the production file, which must exist on disk", () => {
    expect(
      existsSync(path.join(guiAppRoot, SELECTION_PRODUCTION_FILE_PATH)),
    ).toBe(true);
  });

  function selectByIdRestrictedSyntaxMessages(
    messages: readonly Linter.LintMessage[],
  ): readonly Linter.LintMessage[] {
    return messages.filter(
      (message) =>
        message.ruleId === "no-restricted-syntax" &&
        message.message.includes("selectById"),
    );
  }

  async function lintSelectionBypassAt(
    code: string,
    relativePath: string,
  ): Promise<readonly Linter.LintMessage[]> {
    const eslint = new ESLint({ cwd: guiAppRoot });
    const results = await eslint.lintText(code, {
      filePath: path.join(guiAppRoot, relativePath),
    });
    const result = results[0];
    expect(result, `expected a lint result for ${relativePath}`).toBeDefined();
    return result.messages;
  }

  const selectByIdBypassForms = [
    {
      name: "named import",
      code: 'import { selectById } from "@/lib/host/directory";\nvoid selectById;\n',
    },
    {
      name: "quoted named import",
      code: 'import { "selectById" as pick } from "@/lib/host/directory";\nvoid pick;\n',
    },
    {
      name: "computed literal member",
      code: 'const directoryService = { selectById: () => {} };\ndirectoryService["selectById"]("host-1");\n',
    },
    {
      name: "computed template member",
      code: 'const directoryService = { selectById: () => {} };\ndirectoryService[`selectById`]("host-1");\n',
    },
    {
      name: "declaration destructuring",
      code: "const directoryService = { selectById: () => {} };\nconst { selectById } = directoryService;\nvoid selectById;\n",
    },
    {
      name: "template-key declaration destructuring",
      code: "const directoryService = { selectById: () => {} };\nconst { [`selectById`]: pick } = directoryService;\nvoid pick;\n",
    },
  ] as const;

  it.each(selectByIdBypassForms)(
    "catches $name through the real config for a production file",
    async ({ code }) => {
      const messages = await lintSelectionBypassAt(
        code,
        SELECTION_PRODUCTION_FILE_PATH,
      );
      expect(
        selectByIdRestrictedSyntaxMessages(messages).length,
      ).toBeGreaterThanOrEqual(1);
    },
  );

  // App chrome inside `hostSelectionReadAllowlist`: the one place a control
  // for "a legitimate effective-host read is not flagged" can stand, now that
  // the derived-host read is part of the `readPath` ban (PR #1243). It used to
  // stand at `SELECTION_PRODUCTION_FILE_PATH`, outside the allowlist, which
  // encoded the premise that `useEffectiveHostId` was not an app-wide read
  // for lint purposes - the premise the ban retires; see the anchor below it.
  const READ_ALLOWLISTED_PRODUCTION_FILE_PATH =
    "src/components/layout/host-ready-gate.tsx";

  it("anchors the control on the allowlisted production file, which must exist on disk", () => {
    expect(
      existsSync(path.join(guiAppRoot, READ_ALLOWLISTED_PRODUCTION_FILE_PATH)),
    ).toBe(true);
  });

  it("CONTROL: the real config does not flag legitimate effective-host reads or type-only kernel imports where the read is allowlisted", async () => {
    const messages = await lintSelectionBypassAt(
      [
        'import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";',
        'import type { SelectionEvidenceKernel } from "@traycer-clients/shared/host-selection/selection-evidence-kernel";',
        "function describeKernel(kernel: SelectionEvidenceKernel | null): string {",
        "  const hostId = useEffectiveHostId();",
        '  return `${hostId ?? "none"}:${kernel === null ? "none" : "present"}`;',
        "}",
        "void describeKernel;",
        "",
      ].join("\n"),
      READ_ALLOWLISTED_PRODUCTION_FILE_PATH,
    );
    expect(selectByIdRestrictedSyntaxMessages(messages)).toHaveLength(0);
    expect(
      messages.filter(
        (message) =>
          message.ruleId === "@typescript-eslint/no-restricted-imports",
      ),
    ).toHaveLength(0);
  });

  it("and DOES flag the effective-host read at an ordinary production file outside the allowlist", async () => {
    // The old control's location, now an anchor for the opposite claim: the
    // derived-host read is an app-wide read and is banned where the others
    // are. Type-only kernel imports stay clean regardless.
    const messages = await lintSelectionBypassAt(
      [
        'import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";',
        'import type { SelectionEvidenceKernel } from "@traycer-clients/shared/host-selection/selection-evidence-kernel";',
        "void useEffectiveHostId;",
        "export type Kernel = SelectionEvidenceKernel;",
        "",
      ].join("\n"),
      SELECTION_PRODUCTION_FILE_PATH,
    );
    const importMessages = messages.filter(
      (message) =>
        message.ruleId === "@typescript-eslint/no-restricted-imports",
    );
    expect(importMessages).toHaveLength(1);
    expect(importMessages[0]?.message).toContain("useEffectiveHostId");
  });
});
