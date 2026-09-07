import type {
  EpicRuntimeAccountingPort,
  EpicRuntimeAccountingSource,
} from "../epic-runtime-accounting-port";

export interface RecordingAccountingPort extends EpicRuntimeAccountingPort {
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
