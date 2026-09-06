/**
 * The ONE `EpicRuntimeAccountingPort` construction site for tests.
 *
 * One site and an EXPLICIT return type, which is the pairing 4d's `docGuid`
 * sweep proved is needed: a collapsed-but-unannotated helper lets an added
 * contract member fail at every CALL site instead of once here, and the
 * annotation is the half that makes it a single point of failure.
 *
 * It records rather than no-ops, so a suite that wants to assert on accounting
 * can, and one that does not can ignore `calls` entirely.
 */
import type {
  EpicRuntimeAccountingPort,
  EpicRuntimeAccountingSource,
} from "../epic-runtime-accounting-port";

export interface RecordingAccountingPort extends EpicRuntimeAccountingPort {
  /** Every reporting call, in order, as `member:arg…`. */
  readonly calls: string[];
  /** The registered source, or `null` before register / after unregister. */
  registeredSource(): EpicRuntimeAccountingSource | null;
}

export function createRecordingAccountingPort(): RecordingAccountingPort {
  const calls: string[] = [];
  let source: EpicRuntimeAccountingSource | null = null;
  return {
    calls,
    registeredSource: () => source,
    registerBooks(next): void {
      source = next;
      calls.push("registerBooks");
    },
    unregisterBooks(): void {
      source = null;
      calls.push("unregisterBooks");
    },
    settleRootBytes(bytes): void {
      calls.push(`settleRootBytes:${String(bytes)}`);
    },
    settleColdRoomBytes(artifactRoomId, bytes): void {
      calls.push(`settleColdRoomBytes:${artifactRoomId}:${String(bytes)}`);
    },
    settleCommandOverlayBytes(bytes): void {
      calls.push(`settleCommandOverlayBytes:${String(bytes)}`);
    },
    settleHotDocBytes(artifactRoomId, bytes): void {
      calls.push(`settleHotDocBytes:${artifactRoomId}:${String(bytes)}`);
    },
    chargeHotDocProvisional(artifactRoomId, bytes): void {
      calls.push(`chargeHotDocProvisional:${artifactRoomId}:${String(bytes)}`);
    },
    releaseHotDoc(artifactRoomId): void {
      calls.push(`releaseHotDoc:${artifactRoomId}`);
    },
    noteHotDocEvictionDeferred(): void {
      calls.push("noteHotDocEvictionDeferred");
    },
  };
}
