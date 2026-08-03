import { describe, expect, it } from "vitest";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
  StreamFrameEnvelope,
} from "../../i-stream-session";
import { QosClass } from "@traycer/protocol/host-transport/mux";
import { LogicalStream, type LogicalStreamPort } from "../logical-stream";

interface SentFrame {
  readonly streamId: number;
  readonly envelope: StreamFrameEnvelope;
  readonly binaryPayload: Uint8Array | null;
}

function createStream(
  sent: SentFrame[],
  reconnectReasons: string[],
): LogicalStream {
  const port: LogicalStreamPort = {
    sendStreamFrame(
      streamId: number,
      envelope: StreamFrameEnvelope,
      binaryPayload: Uint8Array | null,
    ): void {
      sent.push({ streamId, envelope, binaryPayload });
    },
    closeStream(): void {
      return;
    },
    requestSessionReconnect(reason: string): void {
      reconnectReasons.push(reason);
    },
  };
  return new LogicalStream({
    streamId: 17,
    method: "terminal.subscribe",
    paramsProvider: () => ({}),
    schemaVersion: { major: 1, minor: 0 },
    qos: QosClass.INTERACTIVE,
    port,
  });
}

describe("LogicalStream", () => {
  it("opens only after delivering the first inbound frame", () => {
    const sent: SentFrame[] = [];
    const events: string[] = [];
    const stream = createStream(sent, []);
    const clientFrame = { kind: "input", hasBinaryPayload: false };
    const serverFrame = { kind: "snapshot", hasBinaryPayload: false };

    stream.onServerFrame((envelope) => {
      events.push(`frame:${envelope.kind}`);
    });
    stream.onStatusChange(
      (status: StreamConnectionStatus, _reason: StreamCloseReason | null) => {
        events.push(`status:${status}`);
      },
    );

    stream.sendClientFrame(clientFrame, null);
    expect(sent).toEqual([]);

    expect(stream.deliverServerFrame(serverFrame, null)).toBe(true);
    expect(events).toEqual(["frame:snapshot", "status:open"]);

    stream.sendClientFrame(clientFrame, null);
    expect(sent).toEqual([
      { streamId: 17, envelope: clientFrame, binaryPayload: null },
    ]);
  });

  // A logical stream owns no socket - `requestReconnect` (the post-sleep/wake
  // liveness nudge on `IStreamSession`) is only meaningful if it reaches the
  // shared session that DOES own one. A silent no-op here would leave a woken
  // remote host wedged with no reconnect ever scheduled.
  it("forwards requestReconnect to the shared session, and stops once closed", () => {
    const reconnectReasons: string[] = [];
    const stream = createStream([], reconnectReasons);

    stream.requestReconnect();
    expect(reconnectReasons).toHaveLength(1);

    stream.close();
    stream.requestReconnect();
    expect(reconnectReasons).toHaveLength(1);
  });

  it("replays a terminal failure to a handler installed after subscription setup", () => {
    const stream = createStream([], []);
    const details: FatalErrorDetails = {
      code: "INCOMPATIBLE_METHOD",
      reason: "host does not advertise the method",
      incompatibleMethods: null,
      upgradeGuidance: null,
    };
    stream.goFatal(details);

    const statuses: Array<{
      readonly status: StreamConnectionStatus;
      readonly reason: StreamCloseReason | null;
    }> = [];
    stream.onStatusChange((status, reason) => {
      statuses.push({ status, reason });
    });

    expect(statuses).toEqual([
      {
        status: "closed",
        reason: { kind: "fatalError", details },
      },
    ]);
  });
});
