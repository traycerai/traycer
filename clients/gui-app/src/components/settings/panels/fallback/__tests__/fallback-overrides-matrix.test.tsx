import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { useState, type ReactNode } from "react";
import {
  createDefaultFallbackPolicy,
  type FallbackPolicy,
  type FallbackRungKind,
} from "@traycer/protocol/host/fallback-policy";
import { FALLBACK_REASON_LABELS } from "@traycer/protocol/host/notifications/presentation";
import type { HostNotificationStoppedReason } from "@traycer/protocol/host/notifications/payloads";
import { FallbackOverridesMatrix } from "@/components/settings/panels/fallback/fallback-overrides-matrix";

const BASE_LADDER: readonly FallbackRungKind[] = [
  "profile",
  "tier",
  "wait",
  "notify",
];

const EDITABLE_REASONS: readonly HostNotificationStoppedReason[] = [
  "auth",
  "rate_limit",
  "billing",
  "model_unavailable",
  "provider_unavailable",
];

function policy(overrides: Partial<FallbackPolicy>): FallbackPolicy {
  return {
    ...createDefaultFallbackPolicy(),
    ladder: [...BASE_LADDER],
    ...overrides,
  };
}

interface Handlers {
  readonly onChange: Mock<
    (next: FallbackPolicy, reason: HostNotificationStoppedReason) => void
  >;
  readonly onReset: Mock<
    (reason: HostNotificationStoppedReason | null) => void
  >;
  readonly onUndo: Mock<() => void>;
}

interface RenderOptions {
  readonly undo?: { message: string; disabled: boolean } | null;
  readonly attentionReason?: HostNotificationStoppedReason | null;
  readonly previewUnconfirmed?: boolean;
  readonly status?: ReactNode;
  readonly rungOrder?: readonly FallbackRungKind[];
}

const NO_OPTIONS: RenderOptions = {};

function renderMatrix(fallbackPolicy: FallbackPolicy): Handlers {
  return renderMatrixWith(fallbackPolicy, NO_OPTIONS);
}

function renderMatrixWith(
  fallbackPolicy: FallbackPolicy,
  options: RenderOptions,
): Handlers {
  const handlers: Handlers = {
    onChange:
      vi.fn<
        (next: FallbackPolicy, reason: HostNotificationStoppedReason) => void
      >(),
    onReset: vi.fn<(reason: HostNotificationStoppedReason | null) => void>(),
    onUndo: vi.fn<() => void>(),
  };
  render(
    <FallbackOverridesMatrix
      policy={fallbackPolicy}
      rungOrder={options.rungOrder ?? BASE_LADDER}
      onChange={handlers.onChange}
      onReset={handlers.onReset}
      onUndo={handlers.onUndo}
      undo={options.undo ?? null}
      attentionReason={options.attentionReason ?? null}
      previewUnconfirmed={options.previewUnconfirmed ?? false}
      status={options.status ?? null}
    />,
  );
  return handlers;
}

function rowButton(reason: HostNotificationStoppedReason): HTMLElement {
  return screen.getByRole("button", {
    name: new RegExp(`^${FALLBACK_REASON_LABELS[reason]}`),
  });
}

function openRow(reason: HostNotificationStoppedReason): void {
  fireEvent.click(rowButton(reason));
}

function choice(
  reason: HostNotificationStoppedReason,
  kind: "account" | "model" | "wait",
): HTMLElement {
  const prefix = {
    account: "Try another account",
    model: "Try an equivalent model",
    wait: "Wait for the limit to reset",
  }[kind];
  return screen.getByRole("checkbox", {
    name: `${prefix} for ${FALLBACK_REASON_LABELS[reason]}`,
  });
}

function queryChoice(
  reason: HostNotificationStoppedReason,
  kind: "account" | "model" | "wait",
): HTMLElement | null {
  const prefix = {
    account: "Try another account",
    model: "Try an equivalent model",
    wait: "Wait for the limit to reset",
  }[kind];
  return screen.queryByRole("checkbox", {
    name: `${prefix} for ${FALLBACK_REASON_LABELS[reason]}`,
  });
}

function isChecked(box: HTMLElement): boolean {
  return box.getAttribute("aria-checked") === "true";
}

function lastChange(handlers: Handlers): {
  readonly next: FallbackPolicy;
  readonly reason: HostNotificationStoppedReason;
} {
  const call = handlers.onChange.mock.calls.at(-1);
  if (call === undefined) throw new Error("onChange was not called");
  return { next: call[0], reason: call[1] };
}

afterEach(() => {
  cleanup();
});

describe("FallbackOverridesMatrix - the expandable list", () => {
  it("starts with every editable row collapsed and no checkbox reachable", () => {
    renderMatrix(policy({}));
    for (const reason of EDITABLE_REASONS) {
      expect(rowButton(reason).getAttribute("aria-expanded")).toBe("false");
    }
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("draws exactly five editable rows, each keeping its row testid on the whole row", () => {
    renderMatrix(policy({}));
    for (const reason of EDITABLE_REASONS) {
      const row = screen.getByTestId(`fallback-override-row-${reason}`);
      // The testid is on the ENTIRE row: the disclosure button lives inside it.
      expect(
        within(row).getByRole("button", {
          name: new RegExp(`^${FALLBACK_REASON_LABELS[reason]}`),
        }),
      ).not.toBeNull();
    }
    expect(screen.getAllByTestId(/^fallback-override-row-/)).toHaveLength(5);
  });

  it("opens one row at a time, closing the previous one", () => {
    renderMatrix(policy({}));
    openRow("rate_limit");
    expect(rowButton("rate_limit").getAttribute("aria-expanded")).toBe("true");
    openRow("billing");
    expect(rowButton("billing").getAttribute("aria-expanded")).toBe("true");
    expect(rowButton("rate_limit").getAttribute("aria-expanded")).toBe("false");
  });

  it("toggles a row closed when its button is clicked again", () => {
    renderMatrix(policy({}));
    openRow("rate_limit");
    openRow("rate_limit");
    expect(rowButton("rate_limit").getAttribute("aria-expanded")).toBe("false");
  });

  it("opening and closing rows never mutates the policy", () => {
    const handlers = renderMatrix(
      policy({ reasonOverrides: { rate_limit: ["profile", "notify"] } }),
    );
    openRow("rate_limit");
    openRow("billing");
    openRow("billing");
    expect(handlers.onChange).not.toHaveBeenCalled();
    expect(handlers.onReset).not.toHaveBeenCalled();
    expect(handlers.onUndo).not.toHaveBeenCalled();
  });

  it("Escape inside an open editor closes it and returns focus to the row button", () => {
    renderMatrix(policy({}));
    openRow("rate_limit");
    const box = choice("rate_limit", "account");
    box.focus();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(rowButton("rate_limit").getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(rowButton("rate_limit"));
  });
});

describe("FallbackOverridesMatrix - eligible-only checkboxes", () => {
  it.each([
    ["rate_limit", ["account", "model", "wait"]],
    ["auth", ["account", "model"]],
    ["billing", ["account", "model"]],
    ["model_unavailable", ["model"]],
    ["provider_unavailable", ["model"]],
  ] as const)("%s offers only its eligible choices", (reason, offered) => {
    renderMatrix(policy({}));
    openRow(reason);
    for (const kind of ["account", "model", "wait"] as const) {
      if (offered.some((candidate) => candidate === kind)) {
        expect(queryChoice(reason, kind)).not.toBeNull();
      } else {
        expect(queryChoice(reason, kind)).toBeNull();
      }
    }
  });

  it("checkboxes reflect the effective ladder and expose state without color", () => {
    renderMatrix(
      policy({ reasonOverrides: { rate_limit: ["profile", "notify"] } }),
    );
    openRow("rate_limit");
    expect(isChecked(choice("rate_limit", "account"))).toBe(true);
    expect(isChecked(choice("rate_limit", "model"))).toBe(false);
  });
});

describe("FallbackOverridesMatrix - editing", () => {
  it("unchecking an inherited choice writes a full override and reports the reason", () => {
    const handlers = renderMatrix(policy({}));
    openRow("rate_limit");
    fireEvent.click(choice("rate_limit", "wait"));
    expect(handlers.onChange).toHaveBeenCalledTimes(1);
    const { next, reason } = lastChange(handlers);
    expect(reason).toBe("rate_limit");
    expect(next.reasonOverrides?.rate_limit).toEqual([
      "profile",
      "tier",
      "notify",
    ]);
  });

  it("an off value is distinct from an empty row: it reads as 'recovery disabled', not as unchecked choices", () => {
    renderMatrix(policy({ reasonOverrides: { auth: "off" } }));
    const row = screen.getByTestId("fallback-override-row-auth");
    expect(
      within(row).getByText(/Recovery disabled for this problem/),
    ).not.toBeNull();
    openRow("auth");
    expect(isChecked(choice("auth", "account"))).toBe(false);
    expect(isChecked(choice("auth", "model"))).toBe(false);
  });

  it("enabling a choice on an off row seeds only the clicked step plus the existing terminal notify", () => {
    const handlers = renderMatrix(policy({ reasonOverrides: { auth: "off" } }));
    openRow("auth");
    fireEvent.click(choice("auth", "account"));
    const { next, reason } = lastChange(handlers);
    expect(reason).toBe("auth");
    // Not the base ladder: tier and wait stay off.
    expect(next.reasonOverrides?.auth).toEqual(["profile", "notify"]);
  });

  it("enabling a choice on an off row does not invent a notify the base ladder lacks", () => {
    const handlers = renderMatrixWith(
      policy({
        ladder: ["profile", "tier", "wait"],
        reasonOverrides: { auth: "off" },
      }),
      { rungOrder: ["profile", "tier", "wait", "notify"] },
    );
    openRow("auth");
    fireEvent.click(choice("auth", "model"));
    expect(lastChange(handlers).next.reasonOverrides?.auth).toEqual(["tier"]);
  });

  it("an override equal to the full saved sequence is removed, not stored", () => {
    const handlers = renderMatrix(
      policy({
        reasonOverrides: { rate_limit: ["profile", "tier", "notify"] },
      }),
    );
    openRow("rate_limit");
    fireEvent.click(choice("rate_limit", "wait"));
    expect(lastChange(handlers).next.reasonOverrides).toBeUndefined();
  });

  it("checkbox-only equality is not inheritance: a row with the same visible checks but a different saved sequence stays custom", () => {
    // Base has no notify; the row has the same three visible checkboxes but
    // carries a terminal notify. Visible checkboxes match, the sequence does
    // not - so the row must still be labelled Custom.
    renderMatrix(
      policy({
        ladder: ["profile", "tier", "wait"],
        reasonOverrides: { rate_limit: ["profile", "tier", "wait", "notify"] },
      }),
    );
    const row = screen.getByTestId("fallback-override-row-rate_limit");
    expect(within(row).getByText("Custom")).not.toBeNull();
    expect(within(row).queryByText("Main plan")).toBeNull();
  });

  it("a row without an override is labelled Main plan and the others Custom only when overridden", () => {
    renderMatrix(
      policy({ reasonOverrides: { rate_limit: ["profile", "notify"] } }),
    );
    expect(
      within(screen.getByTestId("fallback-override-row-rate_limit")).getByText(
        "Custom",
      ),
    ).not.toBeNull();
    expect(
      within(screen.getByTestId("fallback-override-row-billing")).getByText(
        "Main plan",
      ),
    ).not.toBeNull();
  });

  it("opening an older custom rule does not reorder it", () => {
    const handlers = renderMatrix(
      policy({
        reasonOverrides: { rate_limit: ["tier", "profile", "notify"] },
      }),
    );
    openRow("rate_limit");
    expect(handlers.onChange).not.toHaveBeenCalled();
  });
});

describe("FallbackOverridesMatrix - contextual notify and transient retries", () => {
  it("all-off on a non-transient row says notify with no countdown, and no retry", () => {
    renderMatrix(policy({ reasonOverrides: { rate_limit: ["notify"] } }));
    openRow("rate_limit");
    const region = screen.getByRole("region", {
      name: new RegExp(FALLBACK_REASON_LABELS.rate_limit),
    });
    expect(within(region).getByText(/No countdown to cancel/)).not.toBeNull();
    // Non-transient row: no retry step and no retry note at all.
    expect(within(region).queryByText(/retry/i)).toBeNull();
  });

  it("all-off on the transient outage row keeps the brief retry", () => {
    renderMatrix(
      policy({ reasonOverrides: { provider_unavailable: ["notify"] } }),
    );
    openRow("provider_unavailable");
    const region = screen.getByRole("region", {
      name: new RegExp(FALLBACK_REASON_LABELS.provider_unavailable),
    });
    // The step list and the explanatory note both say it; the step is the
    // exact-text list item.
    expect(within(region).getByText(/^Brief retry$/)).not.toBeNull();
    expect(
      within(region).getByText(/^Brief retry, then notify you/),
    ).not.toBeNull();
  });

  it("an explicit off outage row does not promise a retry", () => {
    renderMatrix(policy({ reasonOverrides: { provider_unavailable: "off" } }));
    const row = screen.getByTestId(
      "fallback-override-row-provider_unavailable",
    );
    // The disabled copy may say "no ... brief retry" as a negation; only a
    // promised retry STEP is wrong.
    expect(within(row).queryByText(/^Brief retry$/)).toBeNull();
    expect(within(row).queryByText(/Brief retry →/)).toBeNull();
    expect(within(row).getByText(/Recovery disabled/)).not.toBeNull();
  });

  it("a saved sequence with no notify does not promise a brief retry on the outage row", () => {
    renderMatrix(policy({ reasonOverrides: { provider_unavailable: [] } }));
    const row = screen.getByTestId(
      "fallback-override-row-provider_unavailable",
    );
    expect(within(row).queryByText(/Brief retry/)).toBeNull();
  });

  it("billing summary says it always notifies", () => {
    renderMatrix(policy({}));
    const row = screen.getByTestId("fallback-override-row-billing");
    // The row's own summary, not the hidden editor's step list.
    expect(row.textContent).toContain("Always notify you");
  });
});

describe("FallbackOverridesMatrix - notify earlier than other steps", () => {
  const EARLY_NOTIFY = policy({
    ladder: ["profile", "notify", "tier", "wait"],
  });

  it("excludes steps after notify from the preview", () => {
    renderMatrix(EARLY_NOTIFY);
    openRow("rate_limit");
    const preview = screen.getByRole("complementary", {
      name: new RegExp(FALLBACK_REASON_LABELS.rate_limit),
    });
    expect(within(preview).getByText(/another account/i)).not.toBeNull();
    expect(within(preview).queryByText(/equivalent model/i)).toBeNull();
    expect(within(preview).queryByText(/wait for reset/i)).toBeNull();
  });

  it("flags a checked choice that sits after notify as won't run", () => {
    renderMatrix(EARLY_NOTIFY);
    openRow("rate_limit");
    const region = screen.getByRole("region", {
      name: new RegExp(FALLBACK_REASON_LABELS.rate_limit),
    });
    expect(
      within(region).getAllByText(/After notification · won.t run/),
    ).toHaveLength(2);
  });
});

describe("FallbackOverridesMatrix - reset and undo", () => {
  it("Use main plan resets one reason, only when it is custom", () => {
    const handlers = renderMatrix(
      policy({ reasonOverrides: { rate_limit: ["profile", "notify"] } }),
    );
    openRow("rate_limit");
    fireEvent.click(screen.getByRole("button", { name: /Use main plan/ }));
    expect(handlers.onReset).toHaveBeenCalledWith("rate_limit");
    cleanup();
    renderMatrix(policy({}));
    openRow("rate_limit");
    expect(screen.queryByRole("button", { name: /Use main plan/ })).toBeNull();
  });

  it("Reset all to main plan calls onReset(null) and is disabled with no overrides", () => {
    const handlers = renderMatrix(
      policy({ reasonOverrides: { billing: ["notify"] } }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Reset all to main plan" }),
    );
    expect(handlers.onReset).toHaveBeenCalledWith(null);
    cleanup();
    renderMatrix(policy({}));
    expect(
      screen
        .getByRole("button", {
          name: "Reset all to main plan",
        })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("a stored override on a read-only reason keeps Reset all enabled", () => {
    renderMatrix(
      policy({ reasonOverrides: { provider_connection_failed: ["notify"] } }),
    );
    expect(
      screen
        .getByRole("button", {
          name: "Reset all to main plan",
        })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("shows Undo with its message and invokes onUndo", () => {
    const handlers = renderMatrixWith(policy({}), {
      undo: {
        message: "All problems now follow the main plan.",
        disabled: false,
      },
    });
    expect(
      screen.getByText("All problems now follow the main plan."),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(handlers.onUndo).toHaveBeenCalledTimes(1);
  });

  it("disables Undo while the reset is still saving", () => {
    const handlers = renderMatrixWith(policy({}), {
      undo: {
        message: "Rate limit reached now follows the main plan.",
        disabled: true,
      },
    });
    const button = screen.getByRole("button", { name: "Undo" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(handlers.onUndo).not.toHaveBeenCalled();
  });

  it("offers no Undo when undo is null", () => {
    renderMatrix(policy({}));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});

describe("FallbackOverridesMatrix - read-only and excluded problems", () => {
  it("draws connection failure read-only, separate from the editable rows", () => {
    renderMatrix(policy({}));
    expect(
      screen.queryByTestId("fallback-override-row-provider_connection_failed"),
    ).toBeNull();
    expect(
      screen.getByText(FALLBACK_REASON_LABELS.provider_connection_failed),
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", {
        name: new RegExp(
          `^${FALLBACK_REASON_LABELS.provider_connection_failed}`,
        ),
      }),
    ).toBeNull();
  });

  it("a recovery-disabled connection rule cannot promise a retry", () => {
    renderMatrix(
      policy({ reasonOverrides: { provider_connection_failed: "off" } }),
    );
    expect(screen.queryByText(/Brief retry, then notify/)).toBeNull();
    expect(screen.getByText(/Recovery disabled/)).not.toBeNull();
  });

  it("collapses every excluded reason into one read-only disclosure, drawing no row for any", () => {
    renderMatrix(policy({}));
    expect(
      screen.queryByTestId("fallback-override-row-context_exhausted"),
    ).toBeNull();
    const excluded = screen.getByTestId("fallback-override-excluded-row");
    expect(excluded).not.toBeNull();
    expect(excluded.textContent).toContain(
      FALLBACK_REASON_LABELS.context_exhausted,
    );
    expect(excluded.textContent).toContain(
      FALLBACK_REASON_LABELS.session_budget,
    );
  });
});

describe("FallbackOverridesMatrix - status and attention", () => {
  it("renders status outside every collapsible region, even with all rows collapsed", () => {
    renderMatrixWith(policy({}), {
      status: <div data-testid="matrix-status">Save not confirmed.</div>,
    });
    const status = screen.getByTestId("matrix-status");
    expect(status.closest("[hidden]")).toBeNull();
    expect(status.closest("[role='region']")).toBeNull();
    openRow("rate_limit");
    expect(screen.getByTestId("matrix-status")).not.toBeNull();
  });

  it("marks the attention reason's row, and only that row, even when collapsed", () => {
    renderMatrixWith(policy({}), { attentionReason: "rate_limit" });
    const marked = screen.getByTestId("fallback-override-row-rate_limit");
    expect(within(marked).getByText("Check save")).not.toBeNull();
    const other = screen.getByTestId("fallback-override-row-billing");
    expect(within(other).queryByText("Check save")).toBeNull();
  });

  it("labels the preview as unconfirmed while a save is unconfirmed", () => {
    renderMatrixWith(policy({}), { previewUnconfirmed: true });
    openRow("rate_limit");
    // Every row's region stays mounted (hidden), so scope to the open one.
    const region = screen.getByRole("region", {
      name: new RegExp(FALLBACK_REASON_LABELS.rate_limit),
    });
    expect(within(region).getByText(/save not confirmed/i)).not.toBeNull();
  });

  it("does not label the preview unconfirmed otherwise", () => {
    renderMatrixWith(policy({ enabled: true }), { previewUnconfirmed: false });
    openRow("rate_limit");
    const region = screen.getByRole("region", {
      name: new RegExp(FALLBACK_REASON_LABELS.rate_limit),
    });
    expect(within(region).queryByText(/Preview of these choices/)).toBeNull();
    expect(within(region).getByText(/May try available steps/)).not.toBeNull();
  });

  it("describes the preview conditionally while automatic routing is off", () => {
    renderMatrixWith(policy({ enabled: false }), { previewUnconfirmed: false });
    openRow("rate_limit");
    const region = screen.getByRole("region", {
      name: new RegExp(FALLBACK_REASON_LABELS.rate_limit),
    });
    expect(
      within(region).getByText(/If automatic routing is turned on/),
    ).not.toBeNull();
    expect(within(region).queryByText(/May try available steps/)).toBeNull();
  });

  it("an unconfirmed save takes precedence over the routing-off wording", () => {
    renderMatrixWith(policy({ enabled: false }), { previewUnconfirmed: true });
    openRow("rate_limit");
    const region = screen.getByRole("region", {
      name: new RegExp(FALLBACK_REASON_LABELS.rate_limit),
    });
    expect(within(region).getByText(/save not confirmed/i)).not.toBeNull();
  });
});

function StatefulMatrix(props: {
  readonly initial: FallbackPolicy;
}): ReactNode {
  const [current, setCurrent] = useState(props.initial);
  return (
    <FallbackOverridesMatrix
      policy={current}
      rungOrder={BASE_LADDER}
      onChange={(next) => {
        setCurrent(next);
      }}
      onReset={vi.fn()}
      onUndo={vi.fn()}
      undo={null}
      attentionReason={null}
      previewUnconfirmed={false}
      status={null}
    />
  );
}

describe("FallbackOverridesMatrix - stable control order across edits", () => {
  it("turning off the middle action keeps the checkbox in place after the rerender", () => {
    render(<StatefulMatrix initial={policy({})} />);
    openRow("rate_limit");
    const names = (): string[] =>
      screen
        .getAllByRole("checkbox")
        .map((box) => box.getAttribute("aria-label") ?? box.textContent);
    const before = names();
    expect(before).toHaveLength(3);

    fireEvent.click(choice("rate_limit", "model"));
    // The row is now stored as [profile, wait, notify], and tier is off.
    expect(isChecked(choice("rate_limit", "model"))).toBe(false);
    expect(names()).toEqual(before);
    expect(
      screen.getAllByRole("checkbox").map((box) => isChecked(box)),
    ).toEqual([true, false, true]);
  });
});

describe("FallbackOverridesMatrix - read-only entries and accessibility context", () => {
  it("marks the connection entry for attention with Check save", () => {
    renderMatrixWith(policy({}), {
      attentionReason: "provider_connection_failed",
    });
    const label = screen.getByText(
      FALLBACK_REASON_LABELS.provider_connection_failed,
    );
    const entry = label.closest<HTMLElement>("section, div, li") ?? label;
    expect(
      within(entry.parentElement ?? entry).getByText("Check save"),
    ).not.toBeNull();
    expect(screen.getAllByText("Check save")).toHaveLength(1);
  });

  it("marks the excluded disclosure summary, and the affected entry inside it, when an excluded reason owns the save", () => {
    renderMatrixWith(policy({}), { attentionReason: "context_exhausted" });
    const excluded = screen.getByTestId("fallback-override-excluded-row");
    const summary = excluded.querySelector("summary");
    if (summary === null) throw new Error("excluded disclosure has no summary");
    // The always-visible origin warning: present even while the disclosure is closed.
    expect(within(summary).getByText("Check save")).not.toBeNull();
    // Intentionally two badges: the summary, and the entry that owns the save.
    expect(screen.getAllByText("Check save")).toHaveLength(2);
    const entry = screen.getByText(FALLBACK_REASON_LABELS.context_exhausted);
    expect(summary.contains(entry)).toBe(false);
    expect(
      within(entry.parentElement ?? entry).getByText("Check save"),
    ).not.toBeNull();
  });

  it("does not mark the excluded disclosure when no excluded reason owns the save", () => {
    renderMatrixWith(policy({}), { attentionReason: "rate_limit" });
    const summary = screen
      .getByTestId("fallback-override-excluded-row")
      .querySelector("summary");
    expect(summary?.textContent).not.toContain("Check save");
  });

  it("does not mark read-only entries when an editable row owns the save", () => {
    renderMatrixWith(policy({}), { attentionReason: "rate_limit" });
    expect(screen.getAllByText("Check save")).toHaveLength(1);
    const row = screen.getByTestId("fallback-override-row-rate_limit");
    expect(within(row).getByText("Check save")).not.toBeNull();
  });

  it("includes the after-notification context in the checkbox's accessible description", () => {
    renderMatrix(policy({ ladder: ["profile", "notify", "tier", "wait"] }));
    openRow("rate_limit");
    const box = choice("rate_limit", "model");
    const ids = (box.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter((id) => id !== "");
    const description = ids
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(description).toMatch(/After notification/);
    expect(description).toMatch(/won.t run/);
  });

  it("includes the off-in-main-plan context in the checkbox's accessible description", () => {
    renderMatrix(
      policy({
        ladder: ["profile", "notify"],
        reasonOverrides: { rate_limit: ["profile", "tier", "notify"] },
      }),
    );
    openRow("rate_limit");
    const box = choice("rate_limit", "model");
    const description = (box.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter((id) => id !== "")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(description).toMatch(/off in plan|Off in main plan/i);
  });

  it("returns focus to the stable section heading when Undo is used", () => {
    const handlers = renderMatrixWith(policy({}), {
      undo: {
        message: "All problems now follow the main plan.",
        disabled: false,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(handlers.onUndo).toHaveBeenCalledTimes(1);
    const focused = document.activeElement;
    expect(focused).not.toBeNull();
    expect(focused?.getAttribute("tabindex")).toBe("-1");
    expect(focused?.tagName).toMatch(/^H[1-6]$/);
  });

  it("puts focus on the read-only problem's label after its Use main plan reset", () => {
    const handlers = renderMatrix(
      policy({ reasonOverrides: { provider_connection_failed: ["notify"] } }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Use main plan/ }));
    expect(handlers.onReset).toHaveBeenCalledWith("provider_connection_failed");
    const focused = document.activeElement;
    expect(focused?.getAttribute("tabindex")).toBe("-1");
    expect(focused?.textContent).toContain(
      FALLBACK_REASON_LABELS.provider_connection_failed,
    );
  });
});
