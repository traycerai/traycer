import { describe, expect, it } from "vitest";
import {
  formatHostNotificationPresentation,
  hostNotificationEntrySchemaV21,
  hostOperationKnownCopy,
  parseKnownHostNotificationPayloadForKind,
} from "@traycer/protocol/host/notifications/contracts";
import { HOST_OPERATION_WORKSPACE_RECOVERY } from "@traycer/protocol/host/notifications/payloads";

const payload = {
  kind: "workspace_recovery" as const,
  operation: HOST_OPERATION_WORKSPACE_RECOVERY,
  title: "Missing folder removed",
  message: "A folder that no longer exists was detached from this chat.",
  ownerKind: "chat" as const,
  ownerId: "chat-1",
  epicId: "epic-1",
  chatId: "chat-1",
  removed: [{ workspacePath: "/work/gone", runDirectory: "/work/gone/run" }],
};

function entry(over: { readonly payload: Record<string, unknown> }) {
  return hostNotificationEntrySchemaV21.parse({
    id: "workspace.recovery:chat-1:1",
    updatedAt: 1_700_000_000_000,
    readAt: 1_700_000_000_000,
    sourceRef: "chat-1",
    severity: "info",
    epicId: payload.epicId,
    chatId: payload.chatId,
    kind: "host.operation.finished",
    outcome: "completed",
    ...over,
  });
}

describe("workspace recovery host-operation payload", () => {
  it("parses for host.operation.finished only and keeps the host copy", () => {
    const known = parseKnownHostNotificationPayloadForKind(
      "host.operation.finished",
      payload,
    );
    expect(known).toMatchObject({
      kind: "workspace_recovery",
      epicId: "epic-1",
      chatId: "chat-1",
    });
    if (known === null) throw new Error("expected workspace recovery payload");
    expect(hostOperationKnownCopy(known)).toBeNull();
    expect(
      parseKnownHostNotificationPayloadForKind("agent.stopped", payload),
    ).toBeNull();
    expect(formatHostNotificationPresentation(entry({ payload }))).toEqual({
      title: payload.title,
      body: payload.message,
    });
  });

  it("accepts a terminal agent owner with a null chatId", () => {
    expect(
      parseKnownHostNotificationPayloadForKind("host.operation.finished", {
        ...payload,
        ownerKind: "terminal-agent",
        ownerId: "agent-1",
        chatId: null,
      }),
    ).toMatchObject({ ownerKind: "terminal-agent", chatId: null });
  });

  it("degrades a pre-arm row to the common-field tier", () => {
    const preArm = {
      kind: "workspace.recovery",
      operation: payload.operation,
      title: payload.title,
      message: payload.message,
      ownerKind: payload.ownerKind,
      ownerId: payload.ownerId,
      removed: payload.removed,
    };
    expect(
      parseKnownHostNotificationPayloadForKind(
        "host.operation.finished",
        preArm,
      ),
    ).toBeNull();
    expect(
      formatHostNotificationPresentation(entry({ payload: preArm })),
    ).toEqual({ title: payload.title, body: payload.message });
  });
});
