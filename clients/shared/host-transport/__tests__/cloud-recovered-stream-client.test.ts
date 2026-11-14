import { describe, expect, it, vi } from "vitest";
import type { StreamCloseReason } from "../i-stream-session";
import { FakeStreamClient } from "../__testing__/fake-stream-client";
import { CloudRecoveredStreamClient } from "../cloud-recovered-stream-client";

function open(): {
  readonly transport: FakeStreamClient;
  readonly recovered: { count: number };
  readonly statuses: string[];
  readonly client: CloudRecoveredStreamClient;
} {
  const transport = new FakeStreamClient(true);
  const recovered = { count: 0 };
  const statuses: string[] = [];
  const client = new CloudRecoveredStreamClient({
    wsStreamClient: transport,
    onRecovered: () => {
      recovered.count += 1;
    },
    onConnectionStatus: (status: string, _reason: StreamCloseReason | null) => {
      statuses.push(status);
    },
  });
  return { transport, recovered, statuses, client };
}

function firstSession(transport: FakeStreamClient) {
  const session = transport.sessions[0];
  if (session === undefined) throw new Error("no session");
  return session;
}

describe("CloudRecoveredStreamClient", () => {
  it("subscribes cloud.recovered.subscribe with an empty open request", () => {
    const { transport } = open();
    expect(transport.subscribes).toEqual([
      { method: "cloud.recovered.subscribe", params: {} },
    ]);
  });

  it("calls onRecovered once per recovered frame", () => {
    const { transport, recovered } = open();
    const session = firstSession(transport);
    session.emit({ kind: "recovered", hasBinaryPayload: false }, null);
    expect(recovered.count).toBe(1);
    session.emit({ kind: "recovered", hasBinaryPayload: false }, null);
    session.emit({ kind: "recovered", hasBinaryPayload: false }, null);
    expect(recovered.count).toBe(3);
  });

  it("ignores pong frames", () => {
    const { transport, recovered } = open();
    firstSession(transport).emit(
      { kind: "pong", hasBinaryPayload: false },
      null,
    );
    expect(recovered.count).toBe(0);
  });

  it("ignores malformed frames", () => {
    const { transport, recovered } = open();
    const session = firstSession(transport);
    session.emit({ kind: "recovered", hasBinaryPayload: true }, null);
    session.emit({ kind: "unknown", hasBinaryPayload: false }, null);
    expect(recovered.count).toBe(0);
  });

  it("ignores a recovered frame that carries a binary payload", () => {
    const { transport, recovered } = open();
    firstSession(transport).emit(
      { kind: "recovered", hasBinaryPayload: false },
      new Uint8Array([1]),
    );
    expect(recovered.count).toBe(0);
  });

  it("reports connection status transitions", () => {
    const { transport, statuses } = open();
    firstSession(transport).emitStatus("reconnecting");
    expect(statuses).toContain("reconnecting");
  });

  it("closes the session once however often it is closed", () => {
    const { transport, client } = open();
    const session = firstSession(transport);
    const close = vi.spyOn(session, "close");
    client.close();
    client.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
