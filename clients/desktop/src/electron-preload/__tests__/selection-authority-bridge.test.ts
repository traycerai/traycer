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
  listeners: new Map<string, Set<(event: unknown, payload: unknown) => void>>(),
  answer: (_channel: string, _args: readonly unknown[]): unknown => ({
    ok: false,
    kind: "version-mismatch",
    authorityVersion: 99,
    callerVersion: SELECTION_AUTHORITY_CONTRACT_VERSION,
  }),
}));

vi.mock("electron", () => ({
  ipcRenderer: {
    sendSync: (channel: string): unknown => {
      fake.syncChannels.push(channel);
      return 1;
    },
    invoke: (channel: string, ...args: unknown[]): Promise<unknown> => {
      fake.invokeCalls.push({ channel, args });
      return Promise.resolve(fake.answer(channel, args));
    },
    on: (
      channel: string,
      listener: (event: unknown, payload: unknown) => void,
    ) => {
      let listeners = fake.listeners.get(channel);
      if (listeners === undefined) {
        listeners = new Set();
        fake.listeners.set(channel, listeners);
      }
      listeners.add(listener);
    },
    removeListener: (
      channel: string,
      listener: (event: unknown, payload: unknown) => void,
    ) => {
      fake.listeners.get(channel)?.delete(listener);
    },
  },
}));

import { buildSelectionAuthorityBridge } from "../selection-authority-bridge";

beforeEach(() => {
  fake.invokeCalls.length = 0;
  fake.syncChannels.length = 0;
  fake.listeners.clear();
  fake.answer = (_channel, args) => {
    const request = args[0];
    if (typeof request !== "object" || request === null)
      return { ok: false, kind: "superseded" };
    return {
      ok: false,
      kind: "version-mismatch",
      authorityVersion: 99,
      callerVersion: Reflect.get(request, "callerContractVersion"),
    };
  };
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
      authorityVersion: 99,
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

  it("preserves an explicit no-peer answer when effectiveHostId is still connecting", async () => {
    fake.answer = () => ({
      ok: true,
      incarnationId: "inc-current",
      snapshot: {
        contractVersion: SELECTION_AUTHORITY_CONTRACT_VERSION,
        revision: 1,
        preferredHostId: null,
        targetHostId: "host-connecting",
        effectiveHostId: "host-connecting",
        servingPeer: null,
        noPeerPresentation: "connecting",
        leases: [],
      },
    });
    const kernel = new SelectionEvidenceKernel({
      client: buildSelectionAuthorityBridge(),
      now: () => 0,
      log: silentAuthorityLog,
    });

    await kernel.start();

    expect(kernel.snapshot()).toMatchObject({
      effectiveHostId: "host-connecting",
      servingPeer: null,
      noPeerPresentation: "connecting",
    });
    kernel.dispose();
  });

  it("accepts and applies the desktop-v1.5.4 attach and selection event shapes", async () => {
    fake.answer = () => ({
      ok: true,
      incarnationId: "inc-legacy",
      snapshot: {
        contractVersion: 1,
        revision: 4,
        preferredHostId: "host-legacy",
        targetHostId: "host-legacy",
        effectiveHostId: "host-legacy",
        leases: [],
      },
    });
    const kernel = new SelectionEvidenceKernel({
      client: buildSelectionAuthorityBridge(),
      now: () => 0,
      log: silentAuthorityLog,
    });

    await kernel.start();
    expect(kernel.snapshot()).toMatchObject({
      attached: true,
      effectiveHostId: "host-legacy",
      servingPeer: { kind: "computer", hostId: "host-legacy" },
      noPeerPresentation: null,
    });
    const listeners = fake.listeners.get(
      SelectionAuthorityChannels.event.selectionChanged,
    );
    expect(listeners).toBeDefined();
    for (const listener of listeners ?? []) {
      listener(
        {},
        {
          revision: 5,
          change: {
            preferredHostId: null,
            targetHostId: "host-legacy",
            effectiveHostId: null,
            previousEffectiveHostId: "host-legacy",
            cause: "deregister-clear",
          },
        },
      );
    }
    expect(kernel.snapshot()).toMatchObject({
      attached: true,
      effectiveHostId: null,
      servingPeer: null,
      noPeerPresentation: null,
      selectionRevision: 5,
    });
    kernel.dispose();
  });
});
