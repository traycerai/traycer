import { describe, expect, it } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createHostCloudChatReadPort } from "@/lib/chats/cloud-chat-read-port";

const IDENTITY = {
  taskId: "task-1",
  chatId: "chat-1",
  ownerUserId: "owner-1",
} as const;

const PART = {
  identity: IDENTITY,
  sha256: "ab".repeat(32),
  declaredByteLength: 12,
} as const;

/**
 * A requester that records what reached it and never answers: the port is a
 * pre-flight, so "did the request reach the wire" is the whole observable.
 */
function wireRecorder(): {
  readonly reached: string[];
  readonly client: Parameters<typeof createHostCloudChatReadPort>[0];
} {
  const reached: string[] = [];
  return {
    reached,
    client: {
      request: (method) => {
        reached.push(method);
        return Promise.reject(new Error("reached the wire"));
      },
    },
  };
}

describe("createHostCloudChatReadPort", () => {
  it("forwards both calls while the session holds a cloud verdict", async () => {
    const wire = wireRecorder();
    const port = createHostCloudChatReadPort(wire.client, () => true);

    await expect(port.resolveHead(IDENTITY)).rejects.toThrow(
      "reached the wire",
    );
    await expect(port.readPart(PART)).rejects.toThrow("reached the wire");
    expect(wire.reached).toEqual([
      "epic.resolveCloudChatHead",
      "epic.readCloudChatPart",
    ]);
  });

  it("refuses a part read after the verdict is withdrawn mid-pipeline, without reaching the wire", async () => {
    // The reader resolves one head and then fans out part reads; a session
    // demoted after the head must not keep issuing parts through the retained
    // local-host credential. The verdict is re-read per request, not captured
    // at construction.
    const wire = wireRecorder();
    const verdict = { authorized: true };
    const port = createHostCloudChatReadPort(
      wire.client,
      () => verdict.authorized,
    );

    await expect(port.resolveHead(IDENTITY)).rejects.toThrow(
      "reached the wire",
    );
    verdict.authorized = false;

    const refusal = await port.readPart(PART).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(HostRpcError);
    if (!(refusal instanceof HostRpcError)) throw new Error("unreachable");
    expect(refusal.method).toBe("epic.readCloudChatPart");
    expect(refusal.message).toContain("no longer holds a cloud verdict");
    // Only the head reached the wire.
    expect(wire.reached).toEqual(["epic.resolveCloudChatHead"]);
  });

  it("refuses the head itself when the session never held a verdict", async () => {
    const wire = wireRecorder();
    const port = createHostCloudChatReadPort(wire.client, () => false);

    await expect(port.resolveHead(IDENTITY)).rejects.toBeInstanceOf(
      HostRpcError,
    );
    expect(wire.reached).toEqual([]);
  });
});
