import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { ExternalToast } from "sonner";
import type { BatchDeleteItemResult } from "@traycer/protocol/host/epic/unary-schemas";

interface CapturedToast {
  readonly message: ReactNode;
  readonly description: unknown;
}

const toastCalls = vi.hoisted(() => ({
  success: new Array<CapturedToast>(),
  warning: new Array<CapturedToast>(),
  error: new Array<CapturedToast>(),
}));

vi.mock("sonner", () => {
  const capture =
    (bucket: CapturedToast[]) =>
    (message: ReactNode, options: ExternalToast | undefined): string => {
      bucket.push({ message, description: options?.description });
      return "toast";
    };
  return {
    toast: {
      success: capture(toastCalls.success),
      warning: capture(toastCalls.warning),
      error: capture(toastCalls.error),
    },
  };
});

import {
  epicDeleteToastParts,
  emitTaskDeleteSummaryToast,
} from "@/hooks/epic/use-epic-batch-delete-mutation";

/**
 * The delete toast's DESCRIPTION - the host's own reason for the rows it
 * refused.
 *
 * Counting the failures and dropping `errorMessage` was the gap this pins: a
 * batch the host refuses because its local store will not open is exactly the
 * case where the reason is the whole message, and it rendered as a bare
 * "Couldn't delete epic." with nothing to act on. Three of the host's four
 * local-store refusal paths already carry their remedy as data; this is the one
 * that carries it per ROW, in `results[].errorMessage`.
 *
 * Asserted through `epicDeleteToastParts` and `emitTaskDeleteSummaryToast`
 * rather than through the mutation. The mutation needs a host client, a router
 * and a worktree-cleanup stream transport, and a scaffold that large between
 * the assertion and the copy would be asserting the scaffold. Both functions
 * are pure in their inputs; the second reaches the real `joinToastDetails` and
 * the real `emitEpicDeleteToast`, so the sonner calls below are the ones
 * production makes.
 */

const REFUSAL =
  "Traycer can't open this device's local store, so nothing was deleted. Quit the other Traycer on this machine, then rebind.";

function failure(taskId: string, errorMessage: string | undefined) {
  const row: BatchDeleteItemResult = { taskId, success: false, errorMessage };
  return row;
}

function success(taskId: string): BatchDeleteItemResult {
  return { taskId, success: true };
}

function partsFor(
  failures: ReadonlyArray<BatchDeleteItemResult>,
  successes: ReadonlyArray<BatchDeleteItemResult>,
) {
  return epicDeleteToastParts({
    failures,
    successes: successes.length,
    total: failures.length + successes.length,
    deletedIds: successes.map((row) => row.taskId),
    epicTitlesById: {},
  });
}

beforeEach(() => {
  toastCalls.success.length = 0;
  toastCalls.warning.length = 0;
  toastCalls.error.length = 0;
});

describe("the delete toast's description carries the host's reason", () => {
  it("shows the reason for a single failed row", () => {
    const parts = partsFor([failure("epic-1", REFUSAL)], []);

    expect(parts.level).toBe("error");
    expect(parts.message).toBe("Couldn't delete epic.");
    expect(parts.detail).toBe(REFUSAL);
  });

  it("shows a whole-batch refusal's reason ONCE, not once per row", () => {
    // `refuseWholeBatch` writes the SAME sentence onto every id, so five rows
    // carry five copies of it. Asserted by EQUALITY rather than `toContain`:
    // `toContain` passes just as happily on the five-times-repeated string,
    // which is the defect the `Set` exists to prevent.
    const parts = partsFor(
      ["a", "b", "c", "d", "e"].map((id) => failure(id, REFUSAL)),
      [],
    );

    expect(parts.message).toBe("Couldn't delete 5 epics.");
    expect(parts.detail).toBe(REFUSAL);
  });

  it("joins two DISTINCT reasons", () => {
    const parts = partsFor(
      [failure("epic-1", REFUSAL), failure("epic-2", "Worktree is locked.")],
      [],
    );

    expect(parts.detail).toBe(`${REFUSAL} · Worktree is locked.`);
  });

  it("shows no reason at all beyond two distinct ones", () => {
    // The cap is against the DISTINCT count, which is the number a reader
    // actually sees - so it only bites on a genuinely heterogeneous batch, and
    // never on the whole-batch refusal above however many rows it refused.
    const parts = partsFor(
      [
        failure("epic-1", "One."),
        failure("epic-2", "Two."),
        failure("epic-3", "Three."),
      ],
      [],
    );

    expect(parts.detail).toBeNull();
    // The count line still explains that something failed; it is the REASON
    // that is withheld, not the failure.
    expect(parts.message).toBe("Couldn't delete 3 epics.");
  });

  it("shows no reason when the host sent none, or sent blank", () => {
    expect(partsFor([failure("epic-1", undefined)], []).detail).toBeNull();
    expect(partsFor([failure("epic-1", "   ")], []).detail).toBeNull();
    // And a blank one does not occupy a slot in the cap: two real reasons
    // beside a blank still render, rather than being counted as three.
    expect(
      partsFor(
        [
          failure("epic-1", "One."),
          failure("epic-2", "Two."),
          failure("epic-3", "  "),
        ],
        [],
      ).detail,
    ).toBe("One. · Two.");
  });

  it("keeps the reason on a PARTIAL batch, where the message is a tally", () => {
    // The warning arm. Its message counts, so without the detail the toast
    // says "1 failed" and never says why.
    const parts = partsFor([failure("epic-2", REFUSAL)], [success("epic-1")]);

    expect(parts.level).toBe("warning");
    expect(parts.message).toBe("Deleted 1 of 2; 1 failed.");
    expect(parts.detail).toBe(REFUSAL);
  });

  it("carries BOTH halves when a refusal and a failed worktree removal co-occur", () => {
    // The two can happen in one batch - some rows refused, an approved
    // worktree removal then failing - and dropping either leaves the combined
    // toast counting a failure it does not explain. Driven through the real
    // emitter so the ORDER and the separator are production's, not a
    // re-implementation's.
    emitTaskDeleteSummaryToast(
      partsFor([failure("epic-2", REFUSAL)], [success("epic-1")]),
      {
        removed: [],
        failed: [{ worktreePath: "/w/feature", reason: "Directory busy." }],
        uncertain: [],
      },
    );

    expect(toastCalls.warning).toHaveLength(1);
    expect(toastCalls.error).toHaveLength(0);
    expect(toastCalls.warning[0]?.description).toBe(
      `${REFUSAL} · /w/feature: Directory busy.`,
    );
  });

  it("emits the epic reason alone when the cleanup has nothing to report", () => {
    // The control for the case above: `worktreeCleanupSummary` answers `null`
    // for an empty outcome, which takes the other branch of the emitter - so a
    // join that silently dropped its first argument would still look right
    // here, and only the paired case above can tell them apart.
    emitTaskDeleteSummaryToast(partsFor([failure("epic-1", REFUSAL)], []), {
      removed: [],
      failed: [],
      uncertain: [],
    });

    expect(toastCalls.error).toHaveLength(1);
    expect(toastCalls.error[0]?.description).toBe(REFUSAL);
  });
});
