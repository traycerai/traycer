/**
 * A recording {@link EpicRuntimeAccountingPort}, for the suites that drive the
 * accounting seam without T5's real books.
 *
 * One site for the same reason `INERT_ROOT_STATE_PORT` is one: the port is a
 * type that fixtures MIRROR by hand, so every member added to it is a compile
 * error at each of them. It records rather than merely absorbing because the
 * seam's whole claim is about WHICH call a push turns into - a port that
 * swallowed everything would let a settle routed to the wrong member pass.
 *
 * `registerBooks` keeps the source, which is what lets a test call back into
 * the runtime's four inbound members the way the accountant does.
 */
import type {
  EpicRuntimeAccountingPort,
  EpicRuntimeAccountingSource,
} from "../runtime/epic-runtime-accounting-port";

export interface RecordedAccountingCall {
  readonly member: string;
  readonly artifactRoomId: string | null;
  readonly bytes: number | null;
}

export interface RecordingAccountingPort {
  readonly port: EpicRuntimeAccountingPort;
  readonly calls: RecordedAccountingCall[];
  /** The source handed to `registerBooks`, or `null` before/after it. */
  source(): EpicRuntimeAccountingSource | null;
}

export function createRecordingAccountingPort(): RecordingAccountingPort {
  const calls: RecordedAccountingCall[] = [];
  let source: EpicRuntimeAccountingSource | null = null;
  const record = (
    member: string,
    artifactRoomId: string | null,
    bytes: number | null,
  ): void => {
    calls.push({ member, artifactRoomId, bytes });
  };
  return {
    calls,
    source: () => source,
    port: {
      registerBooks(next): void {
        source = next;
        record("registerBooks", null, null);
      },
      unregisterBooks(): void {
        source = null;
        record("unregisterBooks", null, null);
      },
      settleRootBytes(bytes): void {
        record("settleRootBytes", null, bytes);
      },
      settleColdRoomBytes(artifactRoomId, bytes): void {
        record("settleColdRoomBytes", artifactRoomId, bytes);
      },
      settleCommandOverlayBytes(bytes): void {
        record("settleCommandOverlayBytes", null, bytes);
      },
      settleHotDocBytes(artifactRoomId, bytes): void {
        record("settleHotDocBytes", artifactRoomId, bytes);
      },
      chargeHotDocProvisional(artifactRoomId, bytes): void {
        record("chargeHotDocProvisional", artifactRoomId, bytes);
      },
      releaseHotDoc(artifactRoomId): void {
        record("releaseHotDoc", artifactRoomId, null);
      },
      noteHotDocEvictionDeferred(): void {
        record("noteHotDocEvictionDeferred", null, null);
      },
    },
  };
}
