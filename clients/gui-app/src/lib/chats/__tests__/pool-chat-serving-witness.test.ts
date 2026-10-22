import { describe, expect, it } from "vitest";
import {
  FakeStreamClient,
  FakeStreamSession,
} from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import type {
  StatusChangeHandler,
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import type { ChatServing } from "@traycer/protocol/host/chat-serving/index";
import { PoolChatServingWitness } from "@/lib/chats/pool-chat-serving-witness";

const CHAT = { hostId: "host-a", epicId: "epic-1", chatId: "chat-1" };

/** A fake session that also lets a test drive the status handler. */
class StatusDrivableSession extends FakeStreamSession {
  private statusListener: StatusChangeHandler | null = null;

  override onStatusChange(handler: StatusChangeHandler): void {
    this.statusListener = handler;
    super.onStatusChange(handler);
  }

  emitStatusWithReason(
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ): void {
    this.statusListener?.(status, reason, null);
  }
}

class StatusDrivableClient extends FakeStreamClient {
  readonly drivable: StatusDrivableSession[] = [];

  override subscribe(method: string, params: unknown): StatusDrivableSession {
    const session = new StatusDrivableSession();
    this.drivable.push(session);
    this.subscribes.push({ method, params });
    session.emitStatus("open");
    return session;
  }
}

function servingFrame(serving: ChatServing) {
  return { kind: "serving", hasBinaryPayload: false, serving };
}

const NOT_VISIBLE: StreamCloseReason = {
  kind: "fatalError",
  details: {
    code: "CHAT_NOT_VISIBLE",
    reason: "chat is not published yet",
    incompatibleMethods: null,
    upgradeGuidance: null,
  },
};

describe("PoolChatServingWitness reopen after a final close", () => {
  it("opens a fresh stream on reopen once the pool ended the old one with a fatal error, keeping the state heard", () => {
    const client = new StatusDrivableClient(true);
    const witness = new PoolChatServingWitness();
    witness.setStreamClient(client);

    witness.retain(CHAT);
    const releaseSecond = witness.retain(CHAT);
    expect(client.subscribes).toHaveLength(1);

    client.drivable[0]?.emit(
      servingFrame({
        ownerHostId: CHAT.hostId,
        state: "at-rest",
        catchingUp: null,
      }),
      null,
    );
    client.drivable[0]?.emitStatusWithReason("closed", NOT_VISIBLE);
    expect(witness.servingFor(CHAT)?.state).toBe("at-rest");

    witness.reopen(CHAT);

    expect(client.subscribes).toHaveLength(2);
    expect(client.subscribes[1]).toEqual({
      method: "chat.serving.subscribe",
      params: { epicId: CHAT.epicId, chatId: CHAT.chatId },
    });
    expect(witness.servingFor(CHAT)?.state).toBe("at-rest");

    client.drivable[1]?.emit(
      servingFrame({
        ownerHostId: CHAT.hostId,
        state: "live",
        catchingUp: null,
      }),
      null,
    );
    expect(witness.servingFor(CHAT)?.state).toBe("live");

    client.drivable[0]?.emit(
      servingFrame({
        ownerHostId: CHAT.hostId,
        state: "at-rest",
        catchingUp: null,
      }),
      null,
    );
    expect(witness.servingFor(CHAT)?.state).toBe("live");

    releaseSecond();
    witness.dispose();
  });

  it("does nothing on a healthy stream", () => {
    const client = new StatusDrivableClient(true);
    const witness = new PoolChatServingWitness();
    witness.setStreamClient(client);
    witness.retain(CHAT);

    witness.reopen(CHAT);

    expect(client.subscribes).toHaveLength(1);
    client.drivable[0]?.emit(
      servingFrame({
        ownerHostId: CHAT.hostId,
        state: "live",
        catchingUp: null,
      }),
      null,
    );
    expect(witness.servingFor(CHAT)?.state).toBe("live");
    expect(client.drivable[0]?.closed).toBe(false);
    witness.dispose();
  });

  it("does nothing for a chat that is not retained", () => {
    const client = new StatusDrivableClient(true);
    const witness = new PoolChatServingWitness();
    witness.setStreamClient(client);

    witness.reopen(CHAT);

    expect(client.subscribes).toHaveLength(0);
    witness.dispose();
  });

  it.each<{
    readonly name: string;
    readonly status: StreamConnectionStatus;
    readonly reason: StreamCloseReason | null;
  }>([
    { name: "a caller close", status: "closed", reason: { kind: "caller" } },
    { name: "a reconnecting status", status: "reconnecting", reason: null },
  ])(
    "keeps the one stream across $name while another holder keeps it",
    ({ status, reason }) => {
      const client = new StatusDrivableClient(true);
      const witness = new PoolChatServingWitness();
      witness.setStreamClient(client);

      const releaseFirst = witness.retain(CHAT);
      witness.retain(CHAT);

      client.drivable[0]?.emitStatusWithReason(status, reason);

      releaseFirst();
      witness.retain(CHAT);

      expect(client.subscribes).toHaveLength(1);
      witness.dispose();
    },
  );
});
