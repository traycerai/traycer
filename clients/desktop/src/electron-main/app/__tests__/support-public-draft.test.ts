import { describe, expect, it } from "vitest";
import type {
  SupportPrivateDiagnostics,
  SupportPrivateDiagnosticsCause,
} from "../../../ipc-contracts/window-types";
import {
  buildPublicDraftFields,
  type BuildPublicDraftInput,
} from "../support-public-draft";

const TRUNCATION_MARKER = " (truncated, see support report)";

const emptyRegistry: SupportPrivateDiagnostics["registry"] = {
  routeTemplate: { status: "unavailable" },
  hostId: { status: "unavailable" },
  epicId: { status: "unavailable" },
  tabId: { status: "unavailable" },
  artifactId: { status: "unavailable" },
  chatId: { status: "unavailable" },
  agentId: { status: "unavailable" },
  harnessId: { status: "unavailable" },
  model: { status: "unavailable" },
  profileId: { status: "unavailable" },
  providerSelectionClass: { status: "unavailable" },
  providerVersion: { status: "unavailable" },
};

function makeCause(
  overrides: Partial<SupportPrivateDiagnosticsCause>,
): SupportPrivateDiagnosticsCause {
  return {
    type: "Error",
    message: "",
    stack: null,
    componentStack: null,
    errorCode: null,
    sourceAction: null,
    timestamp: 0,
    ...overrides,
  };
}

function makeDiagnostics(
  cause: SupportPrivateDiagnosticsCause | null,
): SupportPrivateDiagnostics {
  return {
    cause,
    registry: emptyRegistry,
    fingerprint: null,
    stackFamily: null,
    correlationId: "corr-1",
  };
}

const baseInput: BuildPublicDraftInput = {
  title: "Something broke",
  whatHappened: "The app crashed",
  stepsToReproduce: "",
  expectedBehavior: "",
  actualBehavior: "",
  appVersion: "1.2.3",
  platform: "darwin",
  arch: "arm64",
  reportId: "rpt_abc123",
  privateDiagnostics: undefined,
};

describe("buildPublicDraftFields", () => {
  it("builds a draft with reportId-aware repro when steps are empty and no privateDiagnostics", () => {
    const result = buildPublicDraftFields(baseInput);
    expect(result).toEqual({
      title: "Something broke",
      fields: {
        "what-happened": "The app crashed",
        version: "1.2.3",
        os: "darwin (arm64)",
        component: "Desktop app",
        repro:
          "Not captured step-by-step - see the private support report rpt_abc123.",
      },
      truncated: false,
    });
  });

  it("derives title from sourceAction + errorCode when present", () => {
    const result = buildPublicDraftFields({
      ...baseInput,
      privateDiagnostics: makeDiagnostics(
        makeCause({
          sourceAction: "chat.subscribe",
          errorCode: "RPC_ERROR",
          message: "ignored when errorCode is present",
        }),
      ),
    });
    expect(result.title).toBe("chat.subscribe - RPC_ERROR: Something broke");
  });

  it("derives title from scrubbed first line of message when no errorCode", () => {
    const result = buildPublicDraftFields({
      ...baseInput,
      privateDiagnostics: makeDiagnostics(
        makeCause({
          sourceAction: null,
          errorCode: null,
          message: "boom happened at /Users/anurag/secret/x.ts:1:1\nmore",
        }),
      ),
    });
    // Path scrubbed inside the title itself - privacy guarantee for derived titles.
    expect(result.title).toBe("boom happened at <path-1>: Something broke");
  });

  it("uses the report-id-free placeholder when reportId is null and steps empty", () => {
    const result = buildPublicDraftFields({
      ...baseInput,
      reportId: null,
      stepsToReproduce: "",
    });
    expect(result.fields.repro).toBe("Filed from the in-app reporter.");
  });

  it("truncates a long whatHappened to fit the URL budget", () => {
    const result = buildPublicDraftFields({
      ...baseInput,
      whatHappened: "x".repeat(20_000),
    });
    expect(result.truncated).toBe(true);
    expect(result.fields["what-happened"].endsWith(TRUNCATION_MARKER)).toBe(
      true,
    );
    expect(result.fields["what-happened"].length).toBeLessThan(20_000);
    // Title stays intact when what-happened alone absorbs the cut.
    expect(result.title).toBe("Something broke");
  });

  it("truncates title last when whatHappened and repro alone already fit", () => {
    const result = buildPublicDraftFields({
      ...baseInput,
      title: "T".repeat(9000),
      whatHappened: "The app crashed.",
      stepsToReproduce: "1. Open\n2. Click",
    });
    expect(result.truncated).toBe(true);
    expect(result.title.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it("leaves a short draft untruncated with no truncation marker anywhere", () => {
    const result = buildPublicDraftFields({
      ...baseInput,
      whatHappened: "The app crashed",
      stepsToReproduce: "1. Open app",
      expectedBehavior: "It works",
      actualBehavior: "It crashes",
    });
    expect(result.truncated).toBe(false);
    const blob = JSON.stringify(result);
    expect(blob).not.toContain(TRUNCATION_MARKER);
  });

  describe("what-happened composition", () => {
    it("is just the narrative when expected/actual are empty", () => {
      const result = buildPublicDraftFields(baseInput);
      expect(result.fields["what-happened"]).toBe("The app crashed");
    });

    it("folds non-empty expected/actual behavior in under labeled sections", () => {
      const result = buildPublicDraftFields({
        ...baseInput,
        expectedBehavior: "It should work",
        actualBehavior: "It crashed",
      });
      expect(result.fields["what-happened"]).toBe(
        "The app crashed\n\nExpected: It should work\n\nActual: It crashed",
      );
    });

    it("omits an empty expected or actual section individually", () => {
      const result = buildPublicDraftFields({
        ...baseInput,
        expectedBehavior: "It should work",
        actualBehavior: "",
      });
      expect(result.fields["what-happened"]).toBe(
        "The app crashed\n\nExpected: It should work",
      );
    });

    it("treats whitespace-only expected/actual as empty", () => {
      const result = buildPublicDraftFields({
        ...baseInput,
        expectedBehavior: "   ",
        actualBehavior: "\n",
      });
      expect(result.fields["what-happened"]).toBe("The app crashed");
    });
  });

  describe("repro prefill", () => {
    it("uses the reportId-aware placeholder when steps are empty", () => {
      const result = buildPublicDraftFields({
        ...baseInput,
        stepsToReproduce: "",
        reportId: "rpt_abc123",
      });
      expect(result.fields.repro).toBe(
        "Not captured step-by-step - see the private support report rpt_abc123.",
      );
    });

    it("uses the report-id-free placeholder when steps are empty and reportId is null", () => {
      const result = buildPublicDraftFields({
        ...baseInput,
        stepsToReproduce: "",
        reportId: null,
      });
      expect(result.fields.repro).toBe("Filed from the in-app reporter.");
    });

    it("uses the report-id-free placeholder when steps are whitespace-only and reportId is null", () => {
      const result = buildPublicDraftFields({
        ...baseInput,
        stepsToReproduce: "   \n  ",
        reportId: null,
      });
      expect(result.fields.repro).toBe("Filed from the in-app reporter.");
    });

    it("prefills repro with user-typed steps when present (scrubbed)", () => {
      const result = buildPublicDraftFields({
        ...baseInput,
        stepsToReproduce: "1. Open app\n2. Click button",
      });
      expect(result.fields.repro).toBe("1. Open app\n2. Click button");
    });
  });

  it("scrubs paths and tokens in title/whatHappened/repro before budget fitting", () => {
    const result = buildPublicDraftFields({
      ...baseInput,
      title: "Crash near /Users/anurag/project/x.ts",
      whatHappened:
        "It broke, see /Users/anurag/project/log.txt for the Bearer abc123 token",
      stepsToReproduce: "Check password: secretvalue and /Users/anurag/y.ts",
      expectedBehavior: "",
      actualBehavior: "",
    });
    expect(result.title).not.toContain("/Users/anurag");
    expect(result.title).toContain("<path-");
    expect(result.fields["what-happened"]).not.toContain("/Users/anurag");
    expect(result.fields["what-happened"]).not.toContain("abc123");
    expect(result.fields["what-happened"]).toContain("Bearer <redacted>");
    expect(result.fields.repro).not.toContain("/Users/anurag");
    expect(result.fields.repro).not.toContain("secretvalue");
    expect(result.fields.repro).toContain("password: <redacted>");
  });
});
