/**
 * A recording {@link EpicRuntimeAccountingPort}, for the suites that drive the accounting seam
 * without T5's real books.
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
