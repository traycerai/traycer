import { describe, expect, it } from "vitest";
import type { ProviderNoticeReceiptStep } from "@traycer/protocol/persistence/epic/content-blocks";
import { fallbackHarnessForProviderLabel } from "@/components/chat/fallback/fallback-identity";
import {
  receiptCrossesProviders,
  receiptStepText,
  routingSettledReportText,
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

  it("says when a wait fired, for the account it waited on, and claims no resume", () => {
    const resumedAt = new Date(2026, 5, 15, 1, 2, 0).getTime();
    expect(
      text(
        step({ kind: "wait", resumedAt, profileLabel: "Personal 3" }),
        false,
      ),
    ).toMatch(/^Waited until 1:02\sAM for Personal 3$/);
    expect(
      text(
        step({ kind: "wait", resumedAt, profileLabel: "Personal 3" }),
        false,
      ),
    ).not.toMatch(/resumed/i);
  });

  it("does not invent a time for a wait that never recorded one", () => {
    expect(
      text(
        step({ kind: "wait", resumedAt: null, profileLabel: "Personal 3" }),
        false,
      ),
    ).toBe("Waited for the limit to reset on Personal 3");
    expect(
      text(
        step({ kind: "wait", resumedAt: null, profileLabel: "Personal 3" }),
        false,
      ),
    ).not.toMatch(/resumed/i);
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

describe("receiptStepText for a step kind this build does not know", () => {
  // The wire reads a newer host's kind as `unknown`; the type is the protocol's.
  const unknownStep = step({ kind: "unknown" });

  it("names the provider even when the receipt stays inside one provider", () => {
    expect(text(unknownStep, false)).toBe("Tried Claude Code · Fable on Surya");
  });

  it("reads the same across providers", () => {
    expect(text(unknownStep, true)).toBe("Tried Claude Code · Fable on Surya");
  });

  it("names the model through the resolver, and leaves a slug it cannot resolve", () => {
    expect(text(unknownStep, false)).toContain("Fable");
    expect(text(unknownStep, false)).not.toContain("claude-fable-5");
    expect(
      text(step({ kind: "unknown", providerLabel: "Mystery Agent" }), false),
    ).toBe("Tried Mystery Agent · claude-fable-5 on Surya");
  });

  it("never claims a move", () => {
    for (const crosses of [false, true]) {
      expect(text(unknownStep, crosses)).not.toMatch(/Switched|Retried|Waited/);
    }
  });
});

describe("routingSettledReportText", () => {
  const notice = {
    title: "Routing stopped",
    message: "Every account said no.",
    details: [
      { label: "Tried", value: "2 accounts" },
      { label: "Route", value: "claude/sonnet -> claude/haiku" },
    ],
    receipt: {
      causeLabel: "Rate limit reached",
      steps: [
        step({ kind: "switch", endedLabel: "rate limited" }),
        step({
          kind: "wait",
          profileLabel: "Personal 3",
          resumedAt: Date.UTC(2026, 5, 15, 1, 2, 3),
          endedLabel: "still rate limited",
        }),
      ],
    },
  };

  it("writes the title, message, cause, raw steps and detail rows, one per line", () => {
    expect(routingSettledReportText(notice).split("\n")).toEqual([
      "Routing: Routing stopped",
      "Every account said no.",
      "Cause: Rate limit reached",
      "Step 1: switch · Claude Code · claude-fable-5 · Surya · ended: rate limited",
      "Step 2: wait · Claude Code · claude-fable-5 · Personal 3 · resumed at 2026-06-15T01:02:03.000Z · ended: still rate limited",
      "Tried: 2 accounts",
      "Route: claude/sonnet -> claude/haiku",
    ]);
  });

  it("keeps the raw slug, never the resolved model label", () => {
    const report = routingSettledReportText(notice);
    expect(report).toContain("claude-fable-5");
    expect(report).not.toContain("Fable ·");
  });

  it.each([
    ["null", null],
    ["empty", ""],
  ])("omits the message line when it is %s", (_name, message) => {
    const lines = routingSettledReportText({ ...notice, message }).split("\n");
    expect(lines[0]).toBe("Routing: Routing stopped");
    expect(lines[1]).toBe("Cause: Rate limit reached");
  });

  it("says 'Steps: none' for an empty receipt", () => {
    const report = routingSettledReportText({
      ...notice,
      details: [],
      receipt: { causeLabel: "Rate limit reached", steps: [] },
    });
    expect(report.split("\n")).toEqual([
      "Routing: Routing stopped",
      "Every account said no.",
      "Cause: Rate limit reached",
      "Steps: none",
    ]);
  });

  it("prints the raw number for a resumedAt Date cannot represent, without throwing", () => {
    const report = routingSettledReportText({
      ...notice,
      details: [],
      receipt: {
        causeLabel: "Rate limit reached",
        steps: [step({ kind: "wait", resumedAt: 9e15 })],
      },
    });
    expect(report).toContain("resumed at 9000000000000000 · ended:");
  });
});

describe("routingSettledReportText for the live-drive fixture, as the host writes it", () => {
  const driveStep: ProviderNoticeReceiptStep = {
    kind: "switch",
    providerLabel: "Claude Code",
    modelLabel: "sonnet",
    profileLabel: "Surya 2",
    resumedAt: null,
    endedLabel: "Rate limit reached",
  };

  const driveDetails = [
    { label: "Code", value: "FALLBACK_EXHAUSTED" },
    { label: "Detail", value: "Routing tried 1 option and none worked." },
    { label: "Cause", value: "Every step was tried" },
    { label: "Reason", value: "Rate limit reached" },
    { label: "Failed on", value: "claude/opus (Surya)" },
    { label: "Tried", value: "claude/sonnet (Surya 2)" },
    { label: "Hop 1", value: "claude/opus (Surya) → claude/sonnet (Surya 2)" },
  ];

  function drive(overrides: {
    readonly details: ReadonlyArray<{ label: string; value: string }>;
    readonly steps: ReadonlyArray<ProviderNoticeReceiptStep>;
  }): string[] {
    return routingSettledReportText({
      title: "Routing couldn't recover this turn",
      message: "The rate limit on Claude Code · Surya stands.",
      details: overrides.details,
      receipt: {
        causeLabel: "Every step was tried",
        steps: [...overrides.steps],
      },
    }).split("\n");
  }

  it("writes exactly one Cause line", () => {
    const lines = drive({ details: driveDetails, steps: [driveStep] });
    expect(lines.filter((line) => line.startsWith("Cause:"))).toEqual([
      "Cause: Every step was tried",
    ]);
  });

  it("an exact duplicate line is written once, the first occurrence winning", () => {
    // "Reason" at positions 4 and 8 of the details.
    const lines = drive({
      details: [
        ...driveDetails,
        { label: "Reason", value: "Rate limit reached" },
      ],
      steps: [driveStep],
    });
    expect(
      lines.filter((line) => line === "Reason: Rate limit reached"),
    ).toEqual(["Reason: Rate limit reached"]);
    // The first occurrence keeps its place, between Cause and Failed on.
    const reason = lines.indexOf("Reason: Rate limit reached");
    expect(lines[reason - 1]).toBe("Cause: Every step was tried");
    expect(lines[reason + 1]).toBe("Failed on: claude/opus (Surya)");
    expect(lines).toHaveLength(10);
  });

  it("writes no exact duplicate lines", () => {
    const lines = drive({ details: driveDetails, steps: [driveStep] });
    expect(lines.length).toBe(new Set(lines).size);
  });

  it("drops the provider and slug from a Step line the detail rows already name", () => {
    const lines = drive({ details: driveDetails, steps: [driveStep] });
    expect(lines).toContain(
      "Step 1: switch · Surya 2 · ended: Rate limit reached",
    );
  });

  it("keeps the full report, in order, for the drive fixture", () => {
    expect(drive({ details: driveDetails, steps: [driveStep] })).toEqual([
      "Routing: Routing couldn't recover this turn",
      "The rate limit on Claude Code · Surya stands.",
      "Step 1: switch · Surya 2 · ended: Rate limit reached",
      "Code: FALLBACK_EXHAUSTED",
      "Detail: Routing tried 1 option and none worked.",
      "Cause: Every step was tried",
      "Reason: Rate limit reached",
      "Failed on: claude/opus (Surya)",
      "Tried: claude/sonnet (Surya 2)",
      "Hop 1: claude/opus (Surya) → claude/sonnet (Surya 2)",
    ]);
  });

  it("keeps the Cause line and the full Step line for an older host with no detail rows", () => {
    const lines = drive({ details: [], steps: [driveStep] });
    expect(lines).toContain("Cause: Every step was tried");
    expect(lines).toContain(
      "Step 1: switch · Claude Code · sonnet · Surya 2 · ended: Rate limit reached",
    );
  });

  it("compares the Cause row by value, so a renamed row still suppresses the GUI Cause line", () => {
    const details = driveDetails.map((detail) =>
      detail.label === "Cause" ? { label: "Why", value: detail.value } : detail,
    );
    const lines = drive({ details, steps: [driveStep] });
    expect(lines.filter((line) => line.startsWith("Cause:"))).toEqual([]);
    expect(lines).toContain("Why: Every step was tried");
  });

  it("still drops the provider and slug when the host renders a terminal account with no label", () => {
    const details = [
      { label: "Tried", value: "claude/sonnet" },
      { label: "Hop 1", value: "claude/opus (Surya) → claude/sonnet" },
    ];
    const lines = drive({ details, steps: [driveStep] });
    expect(lines).toContain(
      "Step 1: switch · Surya 2 · ended: Rate limit reached",
    );
  });

  it("keeps the provider and slug when the rows only name a longer slug", () => {
    const details = [{ label: "Tried", value: "claude/sonnet-4 (Surya 2)" }];
    const lines = drive({ details, steps: [driveStep] });
    expect(lines).toContain(
      "Step 1: switch · Claude Code · sonnet · Surya 2 · ended: Rate limit reached",
    );
  });

  it("keeps the full Step line for a provider this build does not know", () => {
    const mystery: ProviderNoticeReceiptStep = {
      ...driveStep,
      providerLabel: "Mystery Agent",
    };
    const details = [{ label: "Tried", value: "claude/sonnet (Surya 2)" }];
    const lines = drive({ details, steps: [mystery] });
    expect(lines).toContain(
      "Step 1: switch · Mystery Agent · sonnet · Surya 2 · ended: Rate limit reached",
    );
  });

  it("drops the provider and slug from a wait step on the failed tuple", () => {
    const wait: ProviderNoticeReceiptStep = {
      kind: "wait",
      providerLabel: "Claude Code",
      modelLabel: "opus",
      profileLabel: "Surya",
      resumedAt: Date.UTC(2026, 5, 15, 1, 2, 3),
      endedLabel: "Rate limit reached",
    };
    const lines = drive({ details: driveDetails, steps: [wait] });
    expect(lines).toContain(
      "Step 1: wait · Surya · resumed at 2026-06-15T01:02:03.000Z · ended: Rate limit reached",
    );
  });
});
