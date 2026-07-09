/// <reference types="node" />

import { Linter } from "eslint";
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
});
