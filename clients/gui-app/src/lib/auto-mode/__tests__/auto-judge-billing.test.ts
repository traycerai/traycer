import { describe, expect, it } from "vitest";
import { PROVIDER_DISPLAY_NAMES } from "@traycer/protocol/host/provider-schemas";
import { guiHarnessIdToProviderId } from "@/lib/provider-ordering";
import {
  autoJudgeBillingFor,
  autoJudgeMetaLine,
  autoJudgeSelfBillingWarning,
} from "@/lib/auto-mode/auto-judge-billing";

describe("autoJudgeBillingFor", () => {
  it("resolves null (unset) to traycer - the host's own fallback", () => {
    expect(autoJudgeBillingFor(null)).toEqual({ kind: "traycer" });
  });

  it("resolves the traycer harness id to traycer", () => {
    expect(autoJudgeBillingFor("traycer")).toEqual({ kind: "traycer" });
  });

  it("resolves a known provider harness to its display label", () => {
    const providerId = guiHarnessIdToProviderId("claude");
    expect(providerId).not.toBeNull();
    const expectedLabel =
      providerId === null ? "claude" : PROVIDER_DISPLAY_NAMES[providerId];

    expect(autoJudgeBillingFor("claude")).toEqual({
      kind: "provider",
      harnessId: "claude",
      harnessLabel: expectedLabel,
    });
  });

  it("falls back to the raw harness id as the label when it isn't in the provider catalog", () => {
    expect(autoJudgeBillingFor("some-unknown-harness")).toEqual({
      kind: "provider",
      harnessId: "some-unknown-harness",
      harnessLabel: "some-unknown-harness",
    });
  });
});

describe("autoJudgeSelfBillingWarning", () => {
  it("returns null when the judge is Traycer's own - nothing of the user's is spent", () => {
    expect(autoJudgeSelfBillingWarning({ kind: "traycer" })).toBeNull();
  });

  it("quotes Traycer's own Copilot premium-request call rate for the copilot harness", () => {
    expect(
      autoJudgeSelfBillingWarning({
        kind: "provider",
        harnessId: "copilot",
        harnessLabel: "Copilot",
      }),
    ).toBe(
      "Judge calls are Copilot premium requests — one per command reviewed, so an hour of Auto mode can use 60–350 of your monthly allowance.",
    );
  });

  it("states the generic 'on top of your chat replies' sentence for any other provider harness", () => {
    expect(
      autoJudgeSelfBillingWarning({
        kind: "provider",
        harnessId: "claude",
        harnessLabel: "Claude Code",
      }),
    ).toBe(
      "Judge calls use your own Claude Code account, once per command reviewed — on top of your chat replies.",
    );
  });
});

describe("autoJudgeMetaLine", () => {
  it("names Traycer credits for the traycer kind", () => {
    expect(autoJudgeMetaLine({ kind: "traycer" })).toBe(
      "Uses your Traycer credits.",
    );
  });

  it("names the provider's own account for the provider kind", () => {
    expect(
      autoJudgeMetaLine({
        kind: "provider",
        harnessId: "claude",
        harnessLabel: "Claude Code",
      }),
    ).toBe("Uses your Claude Code account.");
  });
});
