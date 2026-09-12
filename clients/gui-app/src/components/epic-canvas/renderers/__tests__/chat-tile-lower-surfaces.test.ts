import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ChatApprovalState } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  composerHasBlockingApprovals,
  humanActionableApprovals,
  visibleComposerApprovals,
} from "@/components/epic-canvas/renderers/chat-approval-visibility";

describe("visibleComposerApprovals", () => {
  it("suppresses only plan approvals from the generic composer queue", () => {
    const toolApproval = approval("tool-approval", "tool");
    const planApproval = approval("plan-approval", "plan");

    expect(visibleComposerApprovals([toolApproval, planApproval])).toEqual([
      toolApproval,
    ]);
  });
});

describe("composerHasBlockingApprovals", () => {
  it("does not block composer submit for a plan-only pending approval", () => {
    // Plan approvals are resolved via the plan card, so they must not become an
    // invisible composer send gate.
    expect(
      composerHasBlockingApprovals([approval("plan-approval", "plan")], 0),
    ).toBe(false);
  });

  it("blocks composer submit for a non-plan tool approval", () => {
    expect(
      composerHasBlockingApprovals([approval("tool-approval", "tool")], 0),
    ).toBe(true);
  });

  it("blocks composer submit for a pending file-edit approval alongside a plan approval", () => {
    expect(
      composerHasBlockingApprovals([approval("plan-approval", "plan")], 1),
    ).toBe(true);
  });

  it("does not block composer submit for a tool approval a judge is still reviewing", () => {
    expect(
      composerHasBlockingApprovals(
        [approval("judging-approval", "tool", { reviewing: "reviewing" })],
        0,
      ),
    ).toBe(false);
  });

  it("still blocks composer submit for a pending file-edit approval while a judge reviews a tool approval", () => {
    expect(
      composerHasBlockingApprovals(
        [approval("judging-approval", "tool", { reviewing: "checking" })],
        1,
      ),
    ).toBe(true);
  });

  it("blocks composer submit for an actionable tool approval that is no longer under a judge", () => {
    expect(
      composerHasBlockingApprovals(
        [approval("tool-approval", "tool", { reviewing: null })],
        0,
      ),
    ).toBe(true);
  });
});

describe("humanActionableApprovals", () => {
  it("drops plan approvals", () => {
    expect(
      humanActionableApprovals([approval("plan-approval", "plan")]),
    ).toEqual([]);
  });

  it("drops approvals currently under a judge", () => {
    expect(
      humanActionableApprovals([
        approval("judging-approval", "tool", { reviewing: "reviewing" }),
      ]),
    ).toEqual([]);
  });

  it("keeps a non-plan approval that is not under a judge", () => {
    const toolApproval = approval("tool-approval", "tool", {
      reviewing: null,
    });
    expect(humanActionableApprovals([toolApproval])).toEqual([toolApproval]);
  });

  it("keeps only the actionable rows out of a mixed queue", () => {
    const judging = approval("judging-approval", "tool", {
      reviewing: "checking",
    });
    const plan = approval("plan-approval", "plan");
    const actionable = approval("tool-approval", "tool", { reviewing: null });

    expect(humanActionableApprovals([judging, plan, actionable])).toEqual([
      actionable,
    ]);
  });
});

/**
 * Ticket 18 rider (orchestrator, revised per review finding: the runtime
 * half previously mounted a hand-copied structural twin of the measurement
 * effect, which could not fail for a real production lifecycle defect -
 * only for a change to the twin itself). The measurement is now extracted
 * into `useMeasuredElementHeight` (`src/hooks/ui/use-measured-element-
 * height.ts`), which `chat-tile.tsx` actually imports and calls - its own
 * `__tests__/use-measured-element-height.test.tsx` is the REAL runtime
 * coverage (attach/detach, rounding, non-positive-reading guard, all against
 * the production hook, not a copy). This file pins only that `chat-tile.tsx`
 * wires that hook's output into `composerOverlayHeight` - full
 * `ChatTileSessionView` mount (session store + stream + composer) is still
 * out of scope for this gap-fill.
 */
describe("chat-tile lowerSurfacesHeight → composerOverlayHeight (ticket 18 rider)", () => {
  it("wires useMeasuredElementHeight's output into ChatSessionMessagesSurface as composerOverlayHeight", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "../chat-tile.tsx"), "utf8");

    // Production wiring snapshot (chat-tile.tsx, the useMeasuredElementHeight
    // call site + the composerOverlayHeight prop pass).
    expect(source).toMatch(
      /import\s*\{\s*useMeasuredElementHeight\s*\}\s*from\s*"@\/hooks\/ui\/use-measured-element-height"/,
    );
    expect(source).toMatch(
      /setElement:\s*setLowerSurfacesElement,\s*\n\s*element:\s*lowerSurfacesElement,\s*\n\s*height:\s*lowerSurfacesHeight,\s*\n\s*\}\s*=\s*useMeasuredElementHeight\(\)/,
    );
    expect(source).toMatch(
      /composerOverlayHeight=\{\s*lowerSurfacesElement === null \? 0 : lowerSurfacesHeight\s*\}/,
    );
  });

  it("keeps the full-width positioning layer paint-transparent", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "../chat-tile.tsx"), "utf8");

    const overlayMatch = source.match(
      /className="([^"]*)"\s*\n\s*data-chat-lower-surfaces-overlay=""/,
    );
    expect(overlayMatch).not.toBeNull();

    const overlayClasses = overlayMatch?.[1].split(/\s+/) ?? [];
    expect(overlayClasses).toEqual([
      "pointer-events-none",
      "absolute",
      "inset-x-0",
      "bottom-0",
      "z-10",
    ]);
    expect(overlayClasses.some((token) => token.startsWith("bg-"))).toBe(false);
    expect(overlayClasses.some((token) => token.startsWith("after:"))).toBe(
      false,
    );
  });
});

function approval(
  approvalId: string,
  kind: ChatApprovalState["kind"],
  overrides: Partial<Pick<ChatApprovalState, "reviewing" | "reason">> = {},
): ChatApprovalState {
  return {
    approvalId,
    toolName: "tool",
    description: "approval",
    input: null,
    requestedAt: 1,
    reason: null,
    reviewing: null,
    kind,
    planId: kind === "plan" ? "plan-1" : null,
    actions: [],
    ...overrides,
  };
}
