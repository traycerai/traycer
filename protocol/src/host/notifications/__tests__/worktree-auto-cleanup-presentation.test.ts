import { describe, expect, it } from "vitest";
import {
  formatHostNotificationPresentation,
  hostNotificationEntrySchemaV21,
  hostOperationKnownCopy,
  parseKnownHostNotificationPayloadForKind,
} from "@traycer/protocol/host/notifications/contracts";
import { HOST_OPERATION_WORKTREE_AUTO_CLEANUP } from "@traycer/protocol/host/notifications/payloads";

const payload = {
  kind: "worktree_auto_cleanup" as const,
  operation: HOST_OPERATION_WORKTREE_AUTO_CLEANUP,
  title: "Automatic cleanup removed 3 worktrees",
  message: "Removed 3 worktrees; 1 skipped, 0 failed.",
  runId: "7c2a0f11-0000-4000-8000-000000000000",
  hostId: "host-1",
  deletedCount: 3,
  skippedCount: 1,
  failedCount: 0,
  interruptedCount: 0,
};

function entry(over: { readonly payload: Record<string, unknown> }) {
  return hostNotificationEntrySchemaV21.parse({
    id: `worktree.autoCleanup:${payload.runId}`,
    updatedAt: 1_700_000_000_000,
    readAt: null,
    sourceRef: payload.runId,
    // Informational for every outcome mix: an unattended pass reports, it does
    // not demand attention. Failures are detailed in cleanup history.
    severity: "info",
    epicId: null,
    chatId: null,
    kind: "host.operation.finished",
    outcome: "completed",
    ...over,
  });
}

describe("automatic worktree cleanup host-operation presentation", () => {
  it("matches only host operation rows and preserves the host-composed copy", () => {
    const known = parseKnownHostNotificationPayloadForKind(
      "host.operation.finished",
      payload,
    );
    expect(known?.kind).toBe("worktree_auto_cleanup");
    if (known === null) throw new Error("expected auto-cleanup payload");
    // The host already composed this copy at mint time and it is what reached
    // email and hooks; re-deriving it here would make the surfaces disagree.
    expect(hostOperationKnownCopy(known)).toBeNull();
    expect(
      parseKnownHostNotificationPayloadForKind("agent.stopped", payload),
    ).toBeNull();

    expect(formatHostNotificationPresentation(entry({ payload }))).toEqual({
      title: payload.title,
      body: payload.message,
    });
  });

  it("keeps a row readable on a client that predates this arm", () => {
    // The degradation the payload tier exists for: strip the arm this build
    // knows and the row still renders the host's own copy off the common
    // `operation`/`title`/`message` fields, never generic "Host operation
    // finished".
    const unknownToThisBuild = {
      ...payload,
      kind: "worktree_auto_cleanup_v2_from_the_future",
    };
    expect(
      parseKnownHostNotificationPayloadForKind(
        "host.operation.finished",
        unknownToThisBuild,
      ),
    ).toBeNull();
    expect(
      formatHostNotificationPresentation(
        entry({ payload: unknownToThisBuild }),
      ),
    ).toEqual({ title: payload.title, body: payload.message });
  });

  it("degrades a malformed count rather than minting contradictory copy", () => {
    // A negative count is a malformed row: it must fall to the common-field
    // tier (still host copy), not be rendered as if it were structured truth.
    const malformed = { ...payload, deletedCount: -1 };
    expect(
      parseKnownHostNotificationPayloadForKind(
        "host.operation.finished",
        malformed,
      ),
    ).toBeNull();
    expect(
      formatHostNotificationPresentation(entry({ payload: malformed })),
    ).toEqual({ title: payload.title, body: payload.message });
  });
});
