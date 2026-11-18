/**
 * Cross-window migration-run announcer. Intentionally carries only the
 * running bit - each window observes its own progress via the host's
 * multicast stream. The IPC fan-out exists so a window that hasn't yet
 * subscribed (e.g. just opened) can mount the blocking modal immediately.
 */
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../../ipc-contracts/ipc-channels";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";

export interface MigrationRunChangePayload {
  readonly running: boolean;
  readonly originWindowId: string | null;
}

interface MigrationRunState {
  current: MigrationRunChangePayload;
}

const SHARED_STATE: MigrationRunState = {
  current: { running: false, originWindowId: null },
};

export function registerMigrationIpc(bridge: RunnerIpcBridge): void {
  bridge.handleInvoke(
    RunnerHostInvoke.migrationAnnounceRunning,
    async (_event, ...args) => {
      const payload = parsePayload(args[0]);
      if (payload === null) return;
      SHARED_STATE.current = payload;
      bridge.fanOut(RunnerHostEvent.migrationRunChange, payload);
    },
  );

  // Sync read for windows opened after the announce has fired so they can
  // initialize their store before subscribing to live events.
  bridge.handleInvoke(
    RunnerHostInvoke.migrationGetRunningSnapshot,
    async () => {
      return SHARED_STATE.current;
    },
  );
}

function parsePayload(raw: unknown): MigrationRunChangePayload | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const running = record.running;
  if (typeof running !== "boolean") return null;
  const originWindowId = record.originWindowId;
  if (originWindowId !== null && typeof originWindowId !== "string") {
    return null;
  }
  return { running, originWindowId };
}
