import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RunnerHostInvoke,
  RunnerHostSync,
} from "../../../ipc-contracts/ipc-channels";
import { SessionRecordings } from "../../soundtrack/session-recordings";
import type { RunnerIpcBridge } from "../runner-ipc-bridge";
import { registerSoundtrackRecordingIpc } from "../soundtrack-recording-ipc";

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

/** A window's contents: what the channels read of the sender, and its end. */
class FakeWindow extends EventEmitter {
  readonly id: number;

  constructor(id: number) {
    super();
    this.id = id;
  }
}

let folder: string;
let root: string;
// Every store a test made, closed after it so no handle is left to the GC.
let stores: SessionRecordings[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "traycer-recording-ipc-"));
  folder = join(root, "soundtrack-sessions");
  stores = [];
});

afterEach(async () => {
  await Promise.all(stores.map((store) => store.closeAll()));
  await rm(root, { recursive: true, force: true });
});

function recordings(): SessionRecordings {
  let ids = 0;
  const store = new SessionRecordings({
    folder: () => folder,
    now: () => new Date(2026, 10, 6, 17, 22),
    newId: () => {
      ids += 1;
      return `rec-${String(ids)}`;
    },
    reveal: () => undefined,
    warn: () => undefined,
  });
  stores.push(store);
  return store;
}

function register(store: SessionRecordings | null) {
  const syncs = new Map<string, () => unknown>();
  const invokes = new Map<string, InvokeHandler>();
  const disposeFns: Array<() => void> = [];
  const bridge: Pick<
    RunnerIpcBridge,
    "handleInvoke" | "handleSync" | "disposeFns"
  > = {
    disposeFns,
    handleInvoke: (channel, handler) => {
      invokes.set(channel, handler);
    },
    handleSync: (channel, compute) => {
      syncs.set(channel, () => compute({} as IpcMainEvent));
    },
  };
  registerSoundtrackRecordingIpc(bridge, store);
  const call = (
    channel: string,
    window: FakeWindow,
    ...args: unknown[]
  ): unknown => {
    const handler = invokes.get(channel);
    if (handler === undefined) throw new Error(`No handler on ${channel}`);
    return handler({ sender: window } as IpcMainInvokeEvent, ...args);
  };
  return {
    flag: () => syncs.get(RunnerHostSync.soundtrackRecordingAvailable)?.(),
    channels: [...invokes.keys()].toSorted(),
    disposeFns,
    open: (window: FakeWindow, input: unknown) =>
      call(RunnerHostInvoke.openSoundtrackRecording, window, input),
    append: (
      window: FakeWindow,
      recordingId: unknown,
      file: unknown,
      bytes: unknown,
    ) =>
      call(
        RunnerHostInvoke.appendSoundtrackRecording,
        window,
        recordingId,
        file,
        bytes,
      ),
    close: (window: FakeWindow, recordingId: unknown, header: unknown) =>
      call(
        RunnerHostInvoke.closeSoundtrackRecording,
        window,
        recordingId,
        header,
      ),
    reveal: (window: FakeWindow, recordingId: unknown) =>
      call(RunnerHostInvoke.revealSoundtrackRecording, window, recordingId),
  };
}

describe("registerSoundtrackRecordingIpc", () => {
  it("answers false and registers no channel with no recordings", async () => {
    const ipc = register(null);

    expect(ipc.flag()).toBe(false);
    expect(ipc.channels).toEqual([]);
    expect(ipc.disposeFns).toEqual([]);
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("answers true and registers the four channels with recordings", () => {
    const ipc = register(recordings());

    expect(ipc.flag()).toBe(true);
    expect(ipc.channels).toEqual(
      [
        RunnerHostInvoke.openSoundtrackRecording,
        RunnerHostInvoke.appendSoundtrackRecording,
        RunnerHostInvoke.closeSoundtrackRecording,
        RunnerHostInvoke.revealSoundtrackRecording,
      ].toSorted(),
    );
  });

  it("keeps a recording to the window that opened it", async () => {
    const ipc = register(recordings());
    const owner = new FakeWindow(1);
    const other = new FakeWindow(2);
    await ipc.open(owner, { quality: "compressed" });

    await expect(
      ipc.append(other, "rec-1", "audio", new Uint8Array([1])),
    ).resolves.toEqual({ kind: "refused" });
    await expect(ipc.close(other, "rec-1", null)).resolves.toEqual({
      kind: "refused",
    });
    await expect(
      ipc.append(owner, "rec-1", "audio", new Uint8Array([1])),
    ).resolves.toEqual({ kind: "ok" });
  });

  it.each(["destroyed", "render-process-gone"])(
    "closes a window's recordings on %s, and not another's",
    async (event) => {
      const ipc = register(recordings());
      const gone = new FakeWindow(1);
      const staying = new FakeWindow(2);
      await ipc.open(gone, { quality: "compressed" });
      await ipc.open(staying, { quality: "compressed" });

      gone.emit(event);

      await expect(
        ipc.append(gone, "rec-1", "audio", new Uint8Array([1])),
      ).resolves.toEqual({ kind: "refused" });
      await expect(
        ipc.append(staying, "rec-2", "audio", new Uint8Array([1])),
      ).resolves.toEqual({ kind: "ok" });
      // Closed as it stood, not lost: it can still be shown.
      expect(ipc.reveal(gone, "rec-1")).toBe(true);
    },
  );

  it("closes every open recording when the bridge is disposed", async () => {
    const ipc = register(recordings());
    const window = new FakeWindow(1);
    await ipc.open(window, { quality: "compressed" });

    for (const dispose of ipc.disposeFns) dispose();

    await expect(
      ipc.append(window, "rec-1", "audio", new Uint8Array([1])),
    ).resolves.toEqual({ kind: "refused" });
  });
});
