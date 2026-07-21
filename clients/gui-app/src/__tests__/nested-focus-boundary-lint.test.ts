/// <reference types="node" />

import { ESLint, Linter } from "eslint";
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
