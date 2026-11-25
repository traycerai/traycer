import { beforeEach, describe, expect, it, vi } from "vitest";
import { SELECTION_AUTHORITY_CONTRACT_VERSION } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import {
  RunnerHostSync,
  SelectionAuthorityChannels,
} from "../../ipc-contracts/ipc-channels";
import { SelectionEvidenceKernel } from "@traycer-clients/shared/host-selection/selection-evidence-kernel";
import { silentAuthorityLog } from "@traycer-clients/shared/host-selection/selection-authority-engine";

const fake = vi.hoisted(() => ({
  invokeCalls: [] as Array<{ channel: string; args: readonly unknown[] }>,
  syncChannels: [] as string[],
}));

vi.mock("electron", () => ({
  ipcRenderer: {
    sendSync: (channel: string): unknown => {
      fake.syncChannels.push(channel);
      return 1;
    },
    invoke: (channel: string, ...args: unknown[]): Promise<unknown> => {
      fake.invokeCalls.push({ channel, args });
      const request = args[0];
      if (typeof request !== "object" || request === null)
        return Promise.resolve({ ok: false, kind: "superseded" });
      const callerVersion = Reflect.get(request, "callerContractVersion");
      return Promise.resolve({
        ok: false,
        kind: "version-mismatch",
        authorityVersion: 1,
        callerVersion,
      });
    },
    on: () => undefined,
    removeListener: () => undefined,
  },
}));

import { buildSelectionAuthorityBridge } from "../selection-authority-bridge";

beforeEach(() => {
  fake.invokeCalls.length = 0;
  fake.syncChannels.length = 0;
});

describe("buildSelectionAuthorityBridge", () => {
  it("forwards the renderer's compiled contract major through attach IPC", async () => {
    const kernel = new SelectionEvidenceKernel({
      client: buildSelectionAuthorityBridge(),
      now: () => 0,
      log: silentAuthorityLog,
    });
    const result = await kernel.start();
    kernel.dispose();

    expect(result).toEqual({
      ok: false,
      kind: "version-mismatch",
      authorityVersion: 1,
      callerVersion: SELECTION_AUTHORITY_CONTRACT_VERSION,
    });
    expect(fake.invokeCalls).toEqual([
      {
        channel: SelectionAuthorityChannels.invoke.attach,
        args: [
          {
            attachSeq: 1,
            callerContractVersion: SELECTION_AUTHORITY_CONTRACT_VERSION,
            liveSessions: [],
          },
        ],
      },
    ]);
    expect(fake.syncChannels).toEqual([RunnerHostSync.selectionAttachSeq]);
  });
});
