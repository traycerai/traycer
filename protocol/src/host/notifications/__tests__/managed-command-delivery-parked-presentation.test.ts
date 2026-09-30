import { describe, expect, it } from "vitest";
import {
  formatHostNotificationPresentation,
  hostNotificationEntrySchemaV21,
  hostOperationKnownCopy,
  parseKnownHostNotificationPayloadForKind,
} from "@traycer/protocol/host/notifications/contracts";
import { HOST_OPERATION_MANAGED_COMMAND_DELIVERY } from "@traycer/protocol/host/notifications/payloads";

const payload = {
  kind: "managed_command_delivery_parked" as const,
  operation: HOST_OPERATION_MANAGED_COMMAND_DELIVERY,
  title: "Command output is waiting",
  message: "A managed command finished but the chat couldn't receive it.",
  commandId: "2f1d0a2c-0000-4000-8000-000000000002",
  epicId: "epic-1",
  chatId: "chat-1",
};

function entry(over: { readonly payload: Record<string, unknown> }) {
  return hostNotificationEntrySchemaV21.parse({
    id: `managed-command.delivery:${payload.commandId}`,
    updatedAt: 1_700_000_000_000,
    readAt: null,
    sourceRef: payload.commandId,
    severity: "info",
    epicId: payload.epicId,
    chatId: payload.chatId,
    kind: "host.operation.finished",
    outcome: "completed",
    ...over,
  });
}

describe("managed command delivery parked host-operation presentation", () => {
  it("matches only host operation rows and preserves the host-composed copy", () => {
    const known = parseKnownHostNotificationPayloadForKind(
      "host.operation.finished",
      payload,
    );
    expect(known?.kind).toBe("managed_command_delivery_parked");
    if (known === null) throw new Error("expected parked-delivery payload");
    // The host already composed this copy at mint time; re-deriving it here
    // would make the surfaces disagree.
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
    const unknownToThisBuild = {
      ...payload,
      kind: "managed_command_delivery_parked_v2_from_the_future",
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

  it("degrades a legacy row missing epicId/chatId to the common-field tier", () => {
    const legacy = {
      kind: payload.kind,
      operation: payload.operation,
      title: payload.title,
      message: payload.message,
      commandId: payload.commandId,
    };
    expect(
      parseKnownHostNotificationPayloadForKind(
        "host.operation.finished",
        legacy,
      ),
    ).toBeNull();
    expect(
      formatHostNotificationPresentation(entry({ payload: legacy })),
    ).toEqual({ title: payload.title, body: payload.message });
  });
});
