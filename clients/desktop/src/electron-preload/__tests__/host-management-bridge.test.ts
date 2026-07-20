import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunnerHostEvent } from "../../ipc-contracts/ipc-channels";
import type {
  HostOperationKind,
  HostOperationStatus,
} from "../../ipc-contracts/host-management-types";

/**
 * Review follow-up (dialog-hang RCA): `onOperationStatus`'s runtime type
 * guard hand-maintains an allowlist of `HostOperationKind` values. When
 * `restart` and `free-port-and-restart` were added to the shared type, this
 * preload's guard was not updated - it silently dropped main's broadcasts
 * for those kinds before they ever reached `HostOperationStatusListener`, so
 * an already-mounted Doctor/Settings window never saw the live status
 * transition (mount-time `getOperationStatus` reads worked fine, since that
 * path is a direct cast with no guard). These tests pin every current
 * `HostOperationKind` passing through, and the exhaustiveness guard inside
 * `host-management-bridge.ts` (a `Record<HostOperationKind, true>` map, which
 * fails to compile if a member is ever added there without a matching key
 * here) is what keeps this from silently regressing again.
 */

type IpcHandler = (event: unknown, payload: unknown) => void;

interface FakeElectron {
  channels: Map<string, Set<IpcHandler>>;
  emit(channel: string, payload: unknown): void;
  reset(): void;
}

const fakeElectron: FakeElectron = {
  channels: new Map(),
  emit(channel, payload) {
    const handlers = fakeElectron.channels.get(channel);
    if (handlers === undefined) return;
    for (const handler of handlers) {
      handler({}, payload);
    }
  },
  reset() {
    fakeElectron.channels.clear();
  },
};

vi.mock("electron", () => ({
  ipcRenderer: {
    on: (channel: string, handler: IpcHandler): void => {
      let set = fakeElectron.channels.get(channel);
      if (set === undefined) {
        set = new Set();
        fakeElectron.channels.set(channel, set);
      }
      set.add(handler);
    },
    removeListener: (channel: string, handler: IpcHandler): void => {
      fakeElectron.channels.get(channel)?.delete(handler);
    },
    invoke: (): Promise<unknown> => Promise.resolve(undefined),
  },
}));

function makeStatus(kind: HostOperationKind): HostOperationStatus {
  return {
    operationId: `op-${kind}`,
    kind,
    stage: null,
    percent: null,
    bytes: null,
    totalBytes: null,
    message: null,
    startedAt: "2026-05-15T00:00:00Z",
  };
}

// Every member of `HostOperationKind` as of this writing. If the union
// gains a member, `host-management-bridge.ts`'s `HOST_OPERATION_KINDS` map
// fails to compile until it's added there too - update this list to match
// when that happens, so the boundary stays covered.
const ALL_HOST_OPERATION_KINDS: readonly HostOperationKind[] = [
  "install",
  "update",
  "register-service",
  "ensure",
  "restart",
  "free-port-and-restart",
];

describe("host-management-bridge onOperationStatus", () => {
  beforeEach(() => {
    fakeElectron.reset();
  });

  afterEach(() => {
    fakeElectron.reset();
    vi.resetModules();
  });

  it.each(ALL_HOST_OPERATION_KINDS)(
    "passes a %s operation-status broadcast through to the listener",
    async (kind) => {
      vi.resetModules();
      const { buildHostManagementBridge } =
        await import("../host-management-bridge");
      const bridge = buildHostManagementBridge();
      const observed: (HostOperationStatus | null)[] = [];
      const subscription = bridge.onOperationStatus((status) => {
        observed.push(status);
      });

      fakeElectron.emit(
        RunnerHostEvent.hostOperationStatusChange,
        makeStatus(kind),
      );

      expect(observed).toEqual([makeStatus(kind)]);
      subscription.dispose();
    },
  );

  it("passes a null operation-status broadcast through (operation cleared)", async () => {
    vi.resetModules();
    const { buildHostManagementBridge } =
      await import("../host-management-bridge");
    const bridge = buildHostManagementBridge();
    const observed: (HostOperationStatus | null)[] = [];
    const subscription = bridge.onOperationStatus((status) => {
      observed.push(status);
    });

    fakeElectron.emit(RunnerHostEvent.hostOperationStatusChange, null);

    expect(observed).toEqual([null]);
    subscription.dispose();
  });

  it.each(["not-a-real-kind", "toString", "constructor"])(
    "rejects a malformed payload with kind %s",
    async (kind) => {
      vi.resetModules();
      const { buildHostManagementBridge } =
        await import("../host-management-bridge");
      const bridge = buildHostManagementBridge();
      const observed: (HostOperationStatus | null)[] = [];
      const subscription = bridge.onOperationStatus((status) => {
        observed.push(status);
      });

      fakeElectron.emit(RunnerHostEvent.hostOperationStatusChange, {
        ...makeStatus("install"),
        kind,
      });

      expect(observed).toEqual([]);
      subscription.dispose();
    },
  );
});
