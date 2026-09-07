import { describe, expect, it } from "vitest";
import {
  formatHostNotificationPresentation,
  hostNotificationEntrySchemaV21,
  hostOperationKnownCopy,
  parseKnownHostNotificationPayloadForKind,
} from "@traycer/protocol/host/notifications/contracts";
import {
  HOST_NOTIFICATION_WORKTREE_DELETION_FAILURE_KINDS,
  hostNotificationWorktreeDeletionPayloadSchema,
} from "@traycer/protocol/host/notifications/payloads";

describe("worktree deletion host-operation presentation", () => {
  it("matches only host operation rows and preserves the host-composed copy", () => {
    const payload = {
      kind: "worktree_deletion" as const,
      operation: "worktree.deletion" as const,
      title: "Deleted 3 worktrees",
      message: "All 3 worktrees were removed.",
      commandId: "2f1d0a2c-0000-4000-8000-000000000000",
      source: "settings",
      requestedCount: 3,
      deletedCount: 3,
      failedCount: 0,
    };
    const known = parseKnownHostNotificationPayloadForKind(
      "host.operation.finished",
      payload,
    );
    expect(known?.kind).toBe("worktree_deletion");
    if (known === null) throw new Error("expected worktree deletion payload");
    expect(hostOperationKnownCopy(known)).toBeNull();
    expect(
      parseKnownHostNotificationPayloadForKind("agent.stopped", payload),
    ).toBeNull();

    expect(
      formatHostNotificationPresentation(
        hostNotificationEntrySchemaV21.parse({
          id: "worktree.deletion:2f1d0a2c-0000-4000-8000-000000000000",
          updatedAt: 1_700_000_000_000,
          readAt: null,
          sourceRef: payload.commandId,
          severity: "done",
          epicId: null,
          chatId: null,
          kind: "host.operation.finished",
          outcome: "completed",
          payload,
        }),
      ),
    ).toEqual({ title: payload.title, body: payload.message });
  });

  it("parses categorized failure counts and keeps omission compatible", () => {
    const basePayload = {
      kind: "worktree_deletion" as const,
      operation: "worktree.deletion" as const,
      title: "Some worktrees were not deleted",
      message: "Deleted 2 of 5.",
      commandId: "2f1d0a2c-0000-4000-8000-000000000000",
      source: "settings",
      requestedCount: 5,
      deletedCount: 2,
      failedCount: 3,
    };

    expect(
      hostNotificationWorktreeDeletionPayloadSchema.parse(basePayload)
        .failureKinds,
    ).toBeUndefined();

    const parsed = hostNotificationWorktreeDeletionPayloadSchema.parse({
      ...basePayload,
      failureKinds: {
        busy: 2,
        teardown_failed: 1,
      },
    });
    expect(parsed.failureKinds).toEqual({ busy: 2, teardown_failed: 1 });
    expect(HOST_NOTIFICATION_WORKTREE_DELETION_FAILURE_KINDS).toEqual([
      "busy",
      "not_managed",
      "teardown_failed",
      "removal_failed",
    ]);
  });

  it("drops an unknown future failure kind without rejecting known counts", () => {
    const parsed = hostNotificationWorktreeDeletionPayloadSchema.parse({
      kind: "worktree_deletion",
      operation: "worktree.deletion",
      title: "Worktree deletion failed",
      message: "The worktree could not be deleted.",
      commandId: "2f1d0a2c-0000-4000-8000-000000000000",
      source: "settings",
      requestedCount: 1,
      deletedCount: 0,
      failedCount: 1,
      failureKinds: {
        busy: 1,
        holders_changed_again: 1,
      },
    });
    expect(parsed.failureKinds).toEqual({ busy: 1 });
  });
});
