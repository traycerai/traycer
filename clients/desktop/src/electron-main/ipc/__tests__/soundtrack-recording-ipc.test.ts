import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
  RunnerHostSync,
} from "../../../ipc-contracts/ipc-channels";
import { SessionRecordings } from "../../soundtrack/session-recordings";
import type { RunnerIpcBridge } from "../runner-ipc-bridge";
import { registerSoundtrackRecordingIpc } from "../soundtrack-recording-ipc";

// `openGate`: every file open waits for it, as an open still on its way does.
const disk = vi.hoisted(() => ({ openGate: null as Promise<void> | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      await disk.openGate;
      return actual.open(...args);
    },
  };
});

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

/**
 * A window's contents: what the channels read of the sender, and its end. An
 * event main sends it is emitted as `sent`, so it carries no member a real
 * window's contents lacks.
 */
class FakeWindow extends EventEmitter {
  readonly id: number;

  constructor(id: number) {
    super();
    this.id = id;
  }

  send(channel: string): void {
    this.emit("sent", channel);
  }

  isDestroyed(): boolean {
    return false;
  }
}

/** The channels main sends `window` an event on from now. */
function sentTo(window: FakeWindow): string[] {
  const sent: string[] = [];
  window.on("sent", (channel: string) => {
    sent.push(channel);
  });
  return sent;
}

let folder: string;
let root: string;
// Every store a test made, closed after it so no handle is left to the GC.
let stores: SessionRecordings[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "traycer-recording-ipc-"));
  folder = join(root, "soundtrack-sessions");
  stores = [];
  disk.openGate = null;
});

afterEach(async () => {
  vi.useRealTimers();
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
  const finish = registerSoundtrackRecordingIpc(bridge, store);
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
    finish: (deadlineMs: number) => {
      if (finish === null) throw new Error("Nothing records");
      return finish(deadlineMs);
    },
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
      await ipc.append(gone, "rec-1", "audio", new Uint8Array([1]));

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

const FINISHED_HEADER = new Uint8Array(44).fill(7);

describe("registerSoundtrackRecordingIpc: finishing at quit", () => {
  it("asks only the windows that record to finish, and resolves once their close has landed", async () => {
    const ipc = register(recordings());
    const recording = new FakeWindow(1);
    const idle = new FakeWindow(2);
    await ipc.open(idle, { quality: "compressed" });
    await ipc.append(idle, "rec-1", "audio", new Uint8Array(1));
    await ipc.close(idle, "rec-1", null);
    await ipc.open(recording, { quality: "lossless" });
    await ipc.append(recording, "rec-2", "audio", new Uint8Array(44).fill(1));
    const sentToRecording = sentTo(recording);
    const sentToIdle = sentTo(idle);
    // As a renderer does on hearing it: flush, then close with the sizes.
    recording.on("sent", () => {
      void ipc.close(recording, "rec-2", FINISHED_HEADER);
    });

    await ipc.finish(5000);

    expect(sentToRecording).toEqual([
      RunnerHostEvent.soundtrackRecordingFinish,
    ]);
    expect(sentToIdle).toEqual([]);
    const wav = await readFile(join(folder, "session-2026-11-06-1722-2.wav"));
    expect(Array.from(wav)).toEqual(Array(44).fill(7));
  });

  it("closes what a renderer never closed once the deadline passes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const ipc = register(recordings());
    const silent = new FakeWindow(1);
    await ipc.open(silent, { quality: "compressed" });
    await ipc.append(silent, "rec-1", "audio", new Uint8Array(1));
    const sentToSilent = sentTo(silent);

    const finishing = ipc.finish(5000);
    await vi.advanceTimersByTimeAsync(5000);
    await finishing;

    expect(sentToSilent).toEqual([RunnerHostEvent.soundtrackRecordingFinish]);
    await expect(
      ipc.append(silent, "rec-1", "audio", new Uint8Array(1)),
    ).resolves.toEqual({ kind: "refused" });
  });
});

describe("registerSoundtrackRecordingIpc: a window's new document", () => {
  const GRACE_MS = 2000;

  it("lets the old document's recording stay open for the grace, then closes it and only it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const ipc = register(recordings());
    const window = new FakeWindow(1);
    await ipc.open(window, { quality: "compressed" });
    await ipc.append(window, "rec-1", "audio", new Uint8Array(1));

    window.emit("did-navigate");
    // The new document records at once; the old one's recording is not yet
    // closed, so its own close, sent as it unloaded, can land.
    await expect(
      ipc.open(window, { quality: "compressed" }),
    ).resolves.toMatchObject({ recordingId: "rec-2" });
    await ipc.append(window, "rec-2", "audio", new Uint8Array(1));
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    await expect(
      ipc.append(window, "rec-1", "audio", new Uint8Array(1)),
    ).resolves.toEqual({ kind: "ok" });

    await vi.advanceTimersByTimeAsync(1);

    await expect(
      ipc.append(window, "rec-1", "audio", new Uint8Array(1)),
    ).resolves.toEqual({ kind: "refused" });
    await expect(
      ipc.append(window, "rec-2", "audio", new Uint8Array(1)),
    ).resolves.toEqual({ kind: "ok" });
  });

  it("abandons an open still on its way the moment the window navigates", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const gate = Promise.withResolvers<void>();
    disk.openGate = gate.promise;
    const ipc = register(recordings());
    const window = new FakeWindow(1);

    const opening = ipc.open(window, { quality: "compressed" });
    window.emit("did-navigate");
    gate.resolve();

    await expect(opening).resolves.toEqual({ kind: "refused" });
    await expect(readdir(folder)).resolves.toEqual([]);
  });
});
