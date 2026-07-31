import { describe, expect, it } from "vitest";
import type {
  SupportContextRegistrySnapshot,
  SupportPrivateDiagnostics,
  SupportPrivateDiagnosticsCause,
} from "../../../ipc-contracts/window-types";
import {
  buildPublicDraftFields,
  type BuildPublicDraftInput,
} from "../support-public-draft";

const TRUNCATION_MARKER = " (truncated, see support report)";

const emptyRegistry: SupportContextRegistrySnapshot = {
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
  overrides: Partial<SupportPrivateDiagnostics>,
): SupportPrivateDiagnostics {
  return {
    cause: null,
    registry: emptyRegistry,
    fingerprint: null,
    stackFamily: null,
    correlationId: "corr-1",
    ...overrides,
  };
}

const baseInput: BuildPublicDraftInput = {
  type: "bug",
  intent: "The app crashed",
  frequency: null,
  appVersion: "1.2.3",
  platform: "darwin",
  arch: "arm64",
  hostVersion: null,
  reportId: "rpt_abc123",
  privateDiagnostics: undefined,
};

const BASE_ENVIRONMENT_LINE = "Environment: Traycer 1.2.3 · darwin arm64";
const BASE_REPORT_LINE = "Support report: rpt_abc123";

describe("buildPublicDraftFields", () => {
  describe("bug route (bug_report.yml)", () => {
    it("composes what-happened from the narrative, environment line, and report id", () => {
      const result = buildPublicDraftFields(baseInput);
      expect(result.template).toBe("bug_report.yml");
      if (result.template !== "bug_report.yml") return;
      expect(result.fields["what-happened"]).toBe(
        `The app crashed\n\n${BASE_ENVIRONMENT_LINE}\n\n${BASE_REPORT_LINE}`,
      );
      expect(result.fields.version).toBe("1.2.3");
      expect(result.fields.os).toBe("darwin (arm64)");
      expect(result.fields.component).toBe("Desktop app");
      expect(result.fields.repro).toBe(
        "Not captured step-by-step - see the private support report rpt_abc123.",
      );
      expect(result.title).toBe("The app crashed");
      expect(result.truncated).toBe(false);
    });

    it("uses the report-id-free repro placeholder when reportId is null", () => {
      const result = buildPublicDraftFields({ ...baseInput, reportId: null });
      expect(result.template).toBe("bug_report.yml");
      if (result.template !== "bug_report.yml") return;
      expect(result.fields.repro).toBe("Filed from the in-app reporter.");
    });

    it("includes a frequency line ahead of the report id when given", () => {
      const result = buildPublicDraftFields({
        ...baseInput,
        frequency: "every_time",
      });
      expect(result.template).toBe("bug_report.yml");
      if (result.template !== "bug_report.yml") return;
      expect(result.fields["what-happened"]).toBe(
        `The app crashed\n\n${BASE_ENVIRONMENT_LINE}\n\nFrequency: Every time · ${BASE_REPORT_LINE}`,
      );
    });

    it("omits the frequency line entirely when frequency is null", () => {
      const result = buildPublicDraftFields(baseInput);
      expect(result.template).toBe("bug_report.yml");
      if (result.template !== "bug_report.yml") return;
      expect(result.fields["what-happened"]).not.toContain("Frequency:");
    });

    it("includes the host version and harness/model in the environment line when known", () => {
      const result = buildPublicDraftFields({
        ...baseInput,
        hostVersion: "0.4.0",
        privateDiagnostics: makeDiagnostics({
          registry: {
            ...emptyRegistry,
            harnessId: { status: "known", value: "claude" },
            model: { status: "known", value: "opus" },
          },
        }),
      });
      expect(result.template).toBe("bug_report.yml");
      if (result.template !== "bug_report.yml") return;
      expect(result.fields["what-happened"]).toContain(
        "Environment: Traycer 1.2.3 · darwin arm64 · host 0.4.0 · claude / opus",
      );
    });

    it("falls back to a solo harness or model when only one is known", () => {
      const result = buildPublicDraftFields({
        ...baseInput,
        privateDiagnostics: makeDiagnostics({
          registry: {
            ...emptyRegistry,
            harnessId: { status: "stale", value: "codex" },
          },
        }),
      });
      expect(result.template).toBe("bug_report.yml");
      if (result.template !== "bug_report.yml") return;
      expect(result.fields["what-happened"]).toContain(
        "Environment: Traycer 1.2.3 · darwin arm64 · codex",
      );
    });

    it("derives title from sourceAction + errorCode when present", () => {
      const result = buildPublicDraftFields({
        ...baseInput,
        privateDiagnostics: makeDiagnostics({
          cause: makeCause({
            sourceAction: "chat.subscribe",
            errorCode: "RPC_ERROR",
            message: "ignored when errorCode is present",
          }),
        }),
      });
      expect(result.title).toBe("chat.subscribe - RPC_ERROR: The app crashed");
    });

    it("derives title from scrubbed first line of message when no errorCode", () => {
      const result = buildPublicDraftFields({
        ...baseInput,
        privateDiagnostics: makeDiagnostics({
          cause: makeCause({
            sourceAction: null,
            errorCode: null,
            message: "boom happened at /Users/anurag/secret/x.ts:1:1\nmore",
          }),
        }),
      });
      // Path scrubbed inside the title itself - privacy guarantee for derived titles.
      expect(result.title).toBe("boom happened at <path-1>: The app crashed");
    });

    it("falls back to the generic title when intent is empty and there is no cause", () => {
      const result = buildPublicDraftFields({ ...baseInput, intent: "" });
      expect(result.title).toBe("Traycer desktop issue");
    });

    it("caps a very long intent's contribution to the title independently of the URL budget", () => {
      const result = buildPublicDraftFields({
        ...baseInput,
        intent: "x".repeat(20_000),
      });
      expect(result.title.endsWith("…")).toBe(true);
      expect(result.title.length).toBeLessThan(100);
    });

    it("truncates an oversized what-happened to fit the URL budget, leaving title and repro intact", () => {
      const result = buildPublicDraftFields({
        ...baseInput,
        intent: "x".repeat(20_000),
      });
      expect(result.template).toBe("bug_report.yml");
      if (result.template !== "bug_report.yml") return;
      expect(result.truncated).toBe(true);
      expect(result.fields["what-happened"].endsWith(TRUNCATION_MARKER)).toBe(
        true,
      );
      expect(result.fields["what-happened"].length).toBeLessThan(20_000);
      expect(result.title.endsWith(TRUNCATION_MARKER)).toBe(false);
      expect(result.fields.repro).toBe(
        "Not captured step-by-step - see the private support report rpt_abc123.",
      );
    });

    it("leaves a short draft untruncated with no truncation marker anywhere", () => {
      const result = buildPublicDraftFields(baseInput);
      expect(result.truncated).toBe(false);
      expect(JSON.stringify(result)).not.toContain(TRUNCATION_MARKER);
    });

    it("scrubs paths and tokens in the intent (title and what-happened) before budget fitting", () => {
      const result = buildPublicDraftFields({
        ...baseInput,
        intent:
          "It broke, see /Users/anurag/project/log.txt for the Bearer abc123 token",
      });
      expect(result.template).toBe("bug_report.yml");
      if (result.template !== "bug_report.yml") return;
      expect(result.title).not.toContain("/Users/anurag");
      expect(result.title).toContain("<path-");
      expect(result.fields["what-happened"]).not.toContain("/Users/anurag");
      expect(result.fields["what-happened"]).toContain("Bearer <redacted>");
    });
  });

  describe("idea route (feature_request.yml)", () => {
    const ideaInput: BuildPublicDraftInput = { ...baseInput, type: "idea" };

    it("composes problem from the narrative + environment/report lines, and a pointer proposal", () => {
      const result = buildPublicDraftFields(ideaInput);
      expect(result.template).toBe("feature_request.yml");
      if (result.template !== "feature_request.yml") return;
      expect(result.fields.problem).toBe(
        `The app crashed\n\n${BASE_ENVIRONMENT_LINE}\n\n${BASE_REPORT_LINE}`,
      );
      expect(result.fields.proposal).toBe(
        "Not captured separately - see the private support report rpt_abc123.",
      );
      expect(result.fields.alternatives).toBe("");
      expect(result.fields.component).toBe("Desktop app");
    });

    it("uses the report-id-free proposal placeholder when reportId is null", () => {
      const result = buildPublicDraftFields({ ...ideaInput, reportId: null });
      expect(result.template).toBe("feature_request.yml");
      if (result.template !== "feature_request.yml") return;
      expect(result.fields.proposal).toBe("Filed from the in-app reporter.");
    });
  });

  describe("other route (general.yml)", () => {
    const otherInput: BuildPublicDraftInput = { ...baseInput, type: "other" };

    it("composes details from the narrative + environment/report lines", () => {
      const result = buildPublicDraftFields(otherInput);
      expect(result.template).toBe("general.yml");
      if (result.template !== "general.yml") return;
      expect(result.fields.details).toBe(
        `The app crashed\n\n${BASE_ENVIRONMENT_LINE}\n\n${BASE_REPORT_LINE}`,
      );
    });

    it("truncates an oversized details field to fit the URL budget", () => {
      const result = buildPublicDraftFields({
        ...otherInput,
        intent: "x".repeat(20_000),
      });
      expect(result.template).toBe("general.yml");
      if (result.template !== "general.yml") return;
      expect(result.truncated).toBe(true);
      expect(result.fields.details.endsWith(TRUNCATION_MARKER)).toBe(true);
    });
  });
});
