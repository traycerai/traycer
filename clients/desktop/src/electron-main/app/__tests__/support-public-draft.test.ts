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
  imageCount: 0,
  overrideTitle: null,
  privateOutcome: "delivered",
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

    it("caps the final title after composing the symptom and intent", () => {
      const result = buildPublicDraftFields({
        ...baseInput,
        intent: "i".repeat(200),
        privateDiagnostics: makeDiagnostics({
          cause: makeCause({
            sourceAction: "chat.subscribe",
            errorCode: "RPC_ERROR",
          }),
        }),
      });
      expect(result.title.endsWith("…")).toBe(true);
      expect(result.title.length).toBeLessThan(100);
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

    it("uses the derived title when overrideTitle is null", () => {
      const result = buildPublicDraftFields({
        ...baseInput,
        overrideTitle: null,
      });
      expect(result.title).toBe("The app crashed");
    });

    it("scrubs paths/tokens out of an edited overrideTitle before it reaches the draft", () => {
      const result = buildPublicDraftFields({
        ...baseInput,
        overrideTitle:
          "See /Users/anurag/project/log.txt for the Bearer abc123 token",
      });
      expect(result.title).not.toContain("/Users/anurag");
      expect(result.title).toContain("<path-");
      expect(result.title).toContain("Bearer <redacted>");
    });

    it("caps an oversized overrideTitle independently of the URL budget, same as a derived title", () => {
      const result = buildPublicDraftFields({
        ...baseInput,
        overrideTitle: "y".repeat(20_000),
      });
      expect(result.title.endsWith("…")).toBe(true);
      expect(result.title.length).toBeLessThan(100);
    });

    it("falls back to the generic title when overrideTitle scrubs down to nothing", () => {
      const result = buildPublicDraftFields({
        ...baseInput,
        overrideTitle: "   ",
      });
      expect(result.title).toBe("Traycer desktop issue");
    });

    it("re-fits the whole draft to the URL budget using the override title, not the derived one", () => {
      const result = buildPublicDraftFields({
        ...baseInput,
        intent: "x".repeat(20_000),
        overrideTitle: "A short edited title",
      });
      expect(result.template).toBe("bug_report.yml");
      if (result.template !== "bug_report.yml") return;
      expect(result.title).toBe("A short edited title");
      expect(result.truncated).toBe(true);
      expect(result.fields["what-happened"].endsWith(TRUNCATION_MARKER)).toBe(
        true,
      );
    });
  });

  describe("privateOutcome (edited-title round-trip / honest fallback drafts)", () => {
    it("delivered: reports the reportId as-is and the see-private-report repro sentence", () => {
      const result = buildPublicDraftFields({
        ...baseInput,
        privateOutcome: "delivered",
      });
      expect(result.template).toBe("bug_report.yml");
      if (result.template !== "bug_report.yml") return;
      expect(result.fields["what-happened"]).toContain(BASE_REPORT_LINE);
      expect(result.fields.repro).toBe(
        "Not captured step-by-step - see the private support report rpt_abc123.",
      );
    });

    it("unconfirmed: phrases the reportId reference as upload-unconfirmed", () => {
      const result = buildPublicDraftFields({
        ...baseInput,
        privateOutcome: "unconfirmed",
      });
      expect(result.template).toBe("bug_report.yml");
      if (result.template !== "bug_report.yml") return;
      expect(result.fields["what-happened"]).toContain(
        "Support report: rpt_abc123 (upload unconfirmed)",
      );
      expect(result.fields.repro).toBe(
        "Not captured step-by-step - see the private support report rpt_abc123 (upload unconfirmed).",
      );
    });

    it("none: omits the report-ID line entirely and uses the honest no-report repro/proposal/details sentence", () => {
      const result = buildPublicDraftFields({
        ...baseInput,
        privateOutcome: "none",
      });
      expect(result.template).toBe("bug_report.yml");
      if (result.template !== "bug_report.yml") return;
      expect(result.fields["what-happened"]).not.toContain("Support report:");
      expect(result.fields["what-happened"]).not.toContain("rpt_abc123");
      expect(result.fields.repro).toBe("Filed from the in-app reporter.");
    });

    it("none: omits the screenshots line even when imageCount > 0 - none were ever uploaded", () => {
      const result = buildPublicDraftFields({
        ...baseInput,
        privateOutcome: "none",
        imageCount: 2,
      });
      expect(result.template).toBe("bug_report.yml");
      if (result.template !== "bug_report.yml") return;
      expect(result.fields["what-happened"]).not.toContain("screenshot");
      expect(result.fields["what-happened"]).not.toContain(
        "attached to the private report",
      );
    });

    it("unconfirmed: still shows the screenshots line - the images did ride the same (unconfirmed) upload attempt", () => {
      const result = buildPublicDraftFields({
        ...baseInput,
        privateOutcome: "unconfirmed",
        imageCount: 1,
      });
      expect(result.template).toBe("bug_report.yml");
      if (result.template !== "bug_report.yml") return;
      expect(result.fields["what-happened"]).toContain(
        "1 screenshot attached to the private report.",
      );
    });

    it("applies the same outcome phrasing to idea's proposal and other's details placeholders", () => {
      const idea = buildPublicDraftFields({
        ...baseInput,
        type: "idea",
        privateOutcome: "none",
      });
      expect(idea.template).toBe("feature_request.yml");
      if (idea.template !== "feature_request.yml") return;
      expect(idea.fields.proposal).toBe("Filed from the in-app reporter.");

      const other = buildPublicDraftFields({
        ...baseInput,
        type: "other",
        privateOutcome: "none",
      });
      expect(other.template).toBe("general.yml");
      if (other.template !== "general.yml") return;
      expect(other.fields.details).not.toContain("Support report:");
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

  describe("imageCount attachment line (ticket 08)", () => {
    const ATTACHMENT_ONE = "1 screenshot attached to the private report.";
    const ATTACHMENT_TWO = "2 screenshots attached to the private report.";
    const ATTACHMENT_THREE = "3 screenshots attached to the private report.";

    it("omits any attachment line when imageCount is 0", () => {
      const result = buildPublicDraftFields({ ...baseInput, imageCount: 0 });
      expect(result.template).toBe("bug_report.yml");
      if (result.template !== "bug_report.yml") return;
      expect(result.fields["what-happened"]).not.toContain("screenshot");
      expect(result.fields["what-happened"]).not.toContain(
        "attached to the private report",
      );
      expect(result.title).not.toContain("screenshot");
    });

    it("omits any attachment line when imageCount is negative", () => {
      const result = buildPublicDraftFields({ ...baseInput, imageCount: -1 });
      expect(result.template).toBe("bug_report.yml");
      if (result.template !== "bug_report.yml") return;
      expect(result.fields["what-happened"]).not.toContain(
        "attached to the private report",
      );
    });

    it("appends a singular attachment line for imageCount === 1 in the narrative only", () => {
      const result = buildPublicDraftFields({ ...baseInput, imageCount: 1 });
      expect(result.template).toBe("bug_report.yml");
      if (result.template !== "bug_report.yml") return;
      expect(result.fields["what-happened"]).toBe(
        `The app crashed\n\n${BASE_ENVIRONMENT_LINE}\n\n${BASE_REPORT_LINE}\n\n${ATTACHMENT_ONE}`,
      );
      // Title must never carry the attachment line.
      expect(result.title).toBe("The app crashed");
      expect(result.title).not.toContain("screenshot");
    });

    it("appends a plural attachment line for imageCount >= 2", () => {
      const two = buildPublicDraftFields({ ...baseInput, imageCount: 2 });
      expect(two.template).toBe("bug_report.yml");
      if (two.template !== "bug_report.yml") return;
      expect(two.fields["what-happened"]).toContain(ATTACHMENT_TWO);
      expect(two.fields["what-happened"]).not.toContain(ATTACHMENT_ONE);

      const three = buildPublicDraftFields({ ...baseInput, imageCount: 3 });
      expect(three.template).toBe("bug_report.yml");
      if (three.template !== "bug_report.yml") return;
      expect(three.fields["what-happened"]).toContain(ATTACHMENT_THREE);
    });

    it("places the attachment line on idea.problem and other.details, never title", () => {
      const idea = buildPublicDraftFields({
        ...baseInput,
        type: "idea",
        imageCount: 1,
      });
      expect(idea.template).toBe("feature_request.yml");
      if (idea.template !== "feature_request.yml") return;
      expect(idea.fields.problem).toContain(ATTACHMENT_ONE);
      expect(idea.title).not.toContain("screenshot");

      const other = buildPublicDraftFields({
        ...baseInput,
        type: "other",
        imageCount: 2,
      });
      expect(other.template).toBe("general.yml");
      if (other.template !== "general.yml") return;
      expect(other.fields.details).toContain(ATTACHMENT_TWO);
      expect(other.title).not.toContain("screenshot");
    });
  });

  // Live E2E verification (finding N2, P1): a bare API key planted in the
  // user-typed intent question survived into the private Sentry envelope AND
  // the public draft TITLE - the derived title has no key/assignment context
  // to key redaction off of, so it needed the scrubber's token-shape pass
  // (support-scrubber.ts), not a change here. This exercises that fix
  // end-to-end through the real (unmodified) title-derivation code path.
  describe("token-shape redaction reaches the public title (finding N2)", () => {
    const ANTHROPIC_KEY =
      "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890ABCDEFGH";

    it("scrubs a bare API key out of a derived title (no privateDiagnostics.cause)", () => {
      const result = buildPublicDraftFields({
        ...baseInput,
        intent: `My key is ${ANTHROPIC_KEY} and it stopped working`,
      });
      expect(result.title).not.toContain(ANTHROPIC_KEY);
      expect(result.template).toBe("bug_report.yml");
      if (result.template !== "bug_report.yml") return;
      expect(result.fields["what-happened"]).not.toContain(ANTHROPIC_KEY);
    });

    it("scrubs a bare API key out of an edited overrideTitle", () => {
      const result = buildPublicDraftFields({
        ...baseInput,
        overrideTitle: `Failing with ${ANTHROPIC_KEY} in the header`,
      });
      expect(result.title).not.toContain(ANTHROPIC_KEY);
    });

    it("scrubs a bare API key out of the message-derived title symptom", () => {
      const result = buildPublicDraftFields({
        ...baseInput,
        privateDiagnostics: makeDiagnostics({
          cause: makeCause({
            sourceAction: null,
            errorCode: null,
            message: `auth failed for ${ANTHROPIC_KEY}\nmore`,
          }),
        }),
      });
      expect(result.title).not.toContain(ANTHROPIC_KEY);
    });
  });
});
