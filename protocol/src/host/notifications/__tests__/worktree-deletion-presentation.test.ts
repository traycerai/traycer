import { describe, expect, it } from "vitest";
import {
  formatHostNotificationPresentation,
  hostNotificationEntrySchemaV21,
  hostOperationKnownCopy,
  parseKnownHostNotificationPayloadForKind,
} from "@traycer/protocol/host/notifications/contracts";

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
});
