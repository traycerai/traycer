import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CommandRecord,
  CommandResolution,
  CommandState,
} from "@traycer-clients/shared/replica-runtime";
import type { EpicWriteCommandIntent } from "@/stores/epics/open-epic/runtime/epic-write-command";
import { EpicSessionEndedError } from "@/stores/epics/open-epic/store";
import {
  settleDetachedEpicTitleCommit,
  settleEpicTitleWrite,
} from "@/lib/epic-title-write-settlement";

vi.mock("@/lib/reportable-error-toast", () => ({
  reportableErrorToast: vi.fn(),
}));
const { reportableErrorToast } = await import("@/lib/reportable-error-toast");

/**
 * Rejections are asserted through Node's own `process` event rather than
 * `window.addEventListener("unhandledrejection")`: `vitest.config.ts` sets
 * `dangerouslyIgnoreUnhandledErrors` and the setup file registers a
 * process-level swallow, so an empty-array assertion taken off the DOM event
 * reads the same whether nothing rejected or nothing fired at all.
 */
function captureUnhandledRejections(): {
  readonly seen: unknown[];
  readonly stop: () => void;
} {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  return {
    seen,
    stop: () => {
      process.off("unhandledRejection", onUnhandled);
    },
  };
}

/** Two macrotasks: one for the `.then` to run, one for Node to judge it. */
async function drainRejections(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Built to the real `CommandRecord` shape rather than cast into it: the first
 * cut used `as` and hid three fields the type requires, which is exactly the
 * narrowing this repo's rules forbid.
 */
function record(
  state: CommandState,
  resolution: CommandResolution | null,
): CommandRecord<EpicWriteCommandIntent> {
  return {
    commandId: "cmd-1",
    intent: { kind: "update-epic-title", title: "next", updatedAt: 1 },
    state,
    delivery: "settled",
    issuedAtMs: 0,
    attempts: 1,
    expectedEntityVersion: null,
    resolution,
  };
}

describe("settleEpicTitleWrite", () => {
  afterEach(() => {
    vi.mocked(reportableErrorToast).mockClear();
  });

  it("treats the session ending as cancellation: no unhandled rejection, no toast", async () => {
    const capture = captureUnhandledRejections();
    try {
      settleEpicTitleWrite(
        Promise.reject(new EpicSessionEndedError("disposed")),
        { onCommitted: () => {}, source: "test" },
      );
      await drainRejections();
      // THE REDDENING ONE. A fulfillment-only `.then` leaves the rejection
      // `waitForWriteCommand` now raises on teardown unhandled.
      expect(capture.seen).toEqual([]);
      expect(reportableErrorToast).not.toHaveBeenCalled();
    } finally {
      capture.stop();
    }
  });

  it("still runs the caller's committed work", async () => {
    const onCommitted = vi.fn();
    settleEpicTitleWrite(
      Promise.resolve(
        record("committed", {
          kind: "committed",
          hostId: "host-1",
          entityVersion: null,
        }),
      ),
      {
        onCommitted,
        source: "test",
      },
    );
    await drainRejections();
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(reportableErrorToast).not.toHaveBeenCalled();
  });

  it("still toasts a rejected answer with the authority's reason", async () => {
    const rejected = record("rejected", {
      kind: "rejected",
      code: "E_TITLE_TAKEN",
      reason: "title taken",
      retryable: false,
    });
    settleEpicTitleWrite(Promise.resolve(rejected), {
      onCommitted: () => {
        throw new Error("committed work must not run for a rejected answer");
      },
      source: "Epic tabs",
    });
    await drainRejections();
    expect(reportableErrorToast).toHaveBeenCalledWith(
      "Couldn't rename epic.",
      undefined,
      expect.objectContaining({ message: "title taken", source: "Epic tabs" }),
    );
  });

  it("does not swallow a rejection that is not the session ending", async () => {
    const capture = captureUnhandledRejections();
    try {
      settleEpicTitleWrite(Promise.reject(new Error("bridge exploded")), {
        onCommitted: () => {},
        source: "test",
      });
      await drainRejections();
      // The control for the arm above: cancellation is consumed, a genuine
      // failure is NOT, so this fix cannot become a blanket `.catch(() => {})`.
      expect(capture.seen).toHaveLength(1);
    } finally {
      capture.stop();
    }
  });
});

describe("settleDetachedEpicTitleCommit", () => {
  afterEach(() => {
    vi.mocked(reportableErrorToast).mockClear();
  });

  it("reports a pre-dispatch fault instead of leaving it unhandled", async () => {
    const capture = captureUnhandledRejections();
    try {
      settleDetachedEpicTitleCommit(
        // What `enqueueWriteCommand` raises for a real fault:
        // `callOrNullOnTeardown` answers `null` only for a disposed bridge and
        // RETHROWS a decode failure or a worker that threw.
        Promise.reject(new Error("worker threw")),
        "Epic tabs",
      );
      await drainRejections();

      // THE REDDENING PAIR. `onCommit` is void-returning, so the commit was
      // handed to a bare `void`: the fault was an unhandled rejection AND - the
      // half the person renaming experiences - a rename that silently did
      // nothing on the one path here that raised no toast.
      expect(capture.seen).toEqual([]);
      expect(reportableErrorToast).toHaveBeenCalledWith(
        "Couldn't rename epic.",
        undefined,
        expect.objectContaining({ source: "Epic tabs" }),
      );
    } finally {
      capture.stop();
    }
  });

  it("treats the session ending as cancellation: no toast", async () => {
    const capture = captureUnhandledRejections();
    try {
      settleDetachedEpicTitleCommit(
        Promise.reject(new EpicSessionEndedError("disposed")),
        "Epic tabs",
      );
      await drainRejections();

      // The discriminating control. Without it a blanket catch would pass the
      // arm above while turning every host replacement with a rename in flight
      // into a spurious failure toast.
      expect(capture.seen).toEqual([]);
      expect(reportableErrorToast).not.toHaveBeenCalled();
    } finally {
      capture.stop();
    }
  });

  it("stays silent for a commit that resolves", async () => {
    settleDetachedEpicTitleCommit(Promise.resolve(), "Epic tabs");
    await drainRejections();
    expect(reportableErrorToast).not.toHaveBeenCalled();
  });
});
