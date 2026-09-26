import { describe, expect, it } from "vitest";
import type { ProviderNoticeReceiptStep } from "@traycer/protocol/persistence/epic/content-blocks";
import { fallbackHarnessForProviderLabel } from "@/components/chat/fallback/fallback-identity";
import {
  receiptCrossesProviders,
  receiptStepText,
} from "@/components/chat/fallback/routing-receipt";

/**
 * The settled card's receipt lines, as pure text. Expected strings are
 * hand-written; the model resolver is a plain map, so what is under test is the
 * step wording and the provider-naming rule, not the catalogue.
 */

const NOW = new Date(2026, 5, 15, 0, 30, 0).getTime();

function step(
  overrides: Partial<ProviderNoticeReceiptStep>,
): ProviderNoticeReceiptStep {
  return {
    kind: "switch",
    providerLabel: "Claude Code",
    modelLabel: "claude-fable-5",
    profileLabel: "Surya",
    resumedAt: null,
    endedLabel: "rate limited",
    ...overrides,
  };
}

const NAMES: ReadonlyMap<string, string> = new Map([
  ["claude:claude-fable-5", "Fable"],
  ["codex:gpt-6", "GPT-6"],
]);

function modelLabelFor(harnessId: string, model: string): string {
  return NAMES.get(`${harnessId}:${model}`) ?? model;
}

function text(
  input: ProviderNoticeReceiptStep,
  crossesProviders: boolean,
): string {
  return receiptStepText(input, { modelLabelFor, crossesProviders, now: NOW });
}

describe("fallbackHarnessForProviderLabel", () => {
  it("maps a provider display name back to its harness", () => {
    expect(fallbackHarnessForProviderLabel("Claude Code")).toBe("claude");
    expect(fallbackHarnessForProviderLabel("Codex")).toBe("codex");
  });

  it("answers null for a provider this build does not know, and for the harness id itself", () => {
    expect(fallbackHarnessForProviderLabel("Mystery Agent")).toBeNull();
    expect(fallbackHarnessForProviderLabel("")).toBeNull();
    // The key is the DISPLAY name the host rendered, never the wire id.
    expect(fallbackHarnessForProviderLabel("claude")).toBeNull();
  });
});

describe("receiptCrossesProviders", () => {
  it("is false for no steps and for steps on one provider", () => {
    expect(receiptCrossesProviders([])).toBe(false);
    expect(
      receiptCrossesProviders([
        step({ kind: "retry" }),
        step({ kind: "switch", profileLabel: "Personal 3" }),
      ]),
    ).toBe(false);
  });

  it("is true once two steps name different providers", () => {
    expect(
      receiptCrossesProviders([
        step({}),
        step({ providerLabel: "Codex", modelLabel: "gpt-6" }),
      ]),
    ).toBe(true);
  });
});

describe("receiptStepText", () => {
  it("names a switch by resolved model and account within one provider", () => {
    expect(text(step({ kind: "switch" }), false)).toBe(
      "Switched to Fable · Surya",
    );
  });

  it("names a retry the same way", () => {
    expect(text(step({ kind: "retry" }), false)).toBe("Retried Fable · Surya");
  });

  it("names the provider on every line of a receipt that crosses providers", () => {
    expect(
      text(
        step({
          kind: "switch",
          providerLabel: "Codex",
          modelLabel: "gpt-6",
          profileLabel: "Team",
        }),
        true,
      ),
    ).toBe("Switched to Codex · GPT-6 · Team");
    expect(text(step({ kind: "retry" }), true)).toBe(
      "Retried Claude Code · Fable · Surya",
    );
  });

  it("leaves the slug a slug when the model is not in the catalogue or the provider is unknown", () => {
    expect(text(step({ modelLabel: "claude-unlisted-9" }), false)).toBe(
      "Switched to claude-unlisted-9 · Surya",
    );
    expect(
      text(
        step({ providerLabel: "Mystery Agent", modelLabel: "claude-fable-5" }),
        false,
      ),
    ).toBe("Switched to claude-fable-5 · Surya");
  });

  it("says when a wait resumed, on the account it resumed on", () => {
    const resumedAt = new Date(2026, 5, 15, 1, 2, 0).getTime();
    expect(
      text(
        step({ kind: "wait", resumedAt, profileLabel: "Personal 3" }),
        false,
      ),
    ).toMatch(/^Waited until 1:02\sAM, resumed on Personal 3$/);
  });

  it("does not invent a time for a wait that never recorded one", () => {
    expect(
      text(
        step({ kind: "wait", resumedAt: null, profileLabel: "Personal 3" }),
        false,
      ),
    ).toBe("Waited for the limit to reset, resumed on Personal 3");
  });

  it("never prints the model or provider on a wait line, crossing providers or not", () => {
    const line = text(
      step({ kind: "wait", resumedAt: null, profileLabel: "Personal 3" }),
      true,
    );
    expect(line).not.toContain("Fable");
    expect(line).not.toContain("Claude Code");
  });
});
