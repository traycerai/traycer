/**
 * The phone-recognizer adapter: `MobileDeviceDictation` turns the native
 * plugin's start / appendAudio / finish / cancel calls into the callbacks of
 * `IDeviceDictationHost`. The plugin is the only fake; promises are settled by
 * awaiting the adapter's own pending work, never by timers.
 */
import { describe, expect, it, vi } from "vitest";
import type { DeviceDictationCallbacks } from "@traycer-clients/shared/platform/runner-host";
import {
  MobileDeviceDictation,
  type DeviceDictationPluginSlice,
} from "../src/device-dictation";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakePlugin(overrides: Partial<DeviceDictationPluginSlice>) {
  const plugin = {
    isAvailable: vi.fn(() => Promise.resolve({ available: true })),
    start: vi.fn(() => Promise.resolve()),
    appendAudio: vi.fn(() => Promise.resolve()),
    finish: vi.fn(() => Promise.resolve({ text: "" })),
    cancel: vi.fn(() => Promise.resolve()),
    ...overrides,
  } satisfies DeviceDictationPluginSlice;
  return plugin;
}

function fakeCallbacks() {
  return {
    onReady: vi.fn<DeviceDictationCallbacks["onReady"]>(),
    onTranscript: vi.fn<DeviceDictationCallbacks["onTranscript"]>(),
    onFlushed: vi.fn<DeviceDictationCallbacks["onFlushed"]>(),
    onError: vi.fn<DeviceDictationCallbacks["onError"]>(),
  };
}

function openSession(plugin: DeviceDictationPluginSlice) {
  const callbacks = fakeCallbacks();
  const session = new MobileDeviceDictation(plugin).open({
    language: "en-US",
    sampleRate: 16_000,
    callbacks,
  });
  return { session, callbacks };
}

/** Lets the adapter's chained `.then` handlers and queued microtasks run. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

describe("MobileDeviceDictation", () => {
  it("raises onReady once the native session has started", async () => {
    const start = deferred<void>();
    const plugin = fakePlugin({ start: vi.fn(() => start.promise) });
    const { callbacks } = openSession(plugin);

    expect(plugin.start).toHaveBeenCalledWith({
      sessionId: "1",
      language: "en-US",
      sampleRate: 16_000,
    });
    expect(callbacks.onReady).not.toHaveBeenCalled();

    start.resolve();
    await settle();

    expect(callbacks.onReady).toHaveBeenCalledTimes(1);
  });

  it("forwards audio as base64 under the session id", async () => {
    const plugin = fakePlugin({});
    const { session } = openSession(plugin);
    await settle();

    session.sendAudio(new Uint8Array([1, 2, 3, 250]));

    expect(plugin.appendAudio).toHaveBeenCalledWith({
      sessionId: "1",
      audio: "AQID+g==",
    });
  });

  it("resolves a flush into the transcript, then onFlushed", async () => {
    const plugin = fakePlugin({
      finish: vi.fn(() => Promise.resolve({ text: "hello there" })),
    });
    const { session, callbacks } = openSession(plugin);
    await settle();
    const order: string[] = [];
    callbacks.onTranscript.mockImplementation(() => order.push("transcript"));
    callbacks.onFlushed.mockImplementation(() => order.push("flushed"));

    session.flush();
    await settle();

    expect(plugin.finish).toHaveBeenCalledWith({ sessionId: "1" });
    expect(callbacks.onTranscript).toHaveBeenCalledWith("hello there");
    expect(order).toEqual(["transcript", "flushed"]);
  });

  it("reports a refused speech-recognition permission and cancels natively", async () => {
    const denied = Object.assign(new Error("speech access refused"), {
      code: "PERMISSION_DENIED",
    });
    const plugin = fakePlugin({ start: vi.fn(() => Promise.reject(denied)) });
    const { callbacks } = openSession(plugin);
    await settle();

    expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith({
      message: "speech access refused",
      permissionDenied: true,
    });
    expect(plugin.cancel).toHaveBeenCalledWith({ sessionId: "1" });
    expect(callbacks.onReady).not.toHaveBeenCalled();
  });

  it("answers a flush before the native start with onFlushed alone, and cancels the session that starts late", async () => {
    const start = deferred<void>();
    const plugin = fakePlugin({ start: vi.fn(() => start.promise) });
    const { session, callbacks } = openSession(plugin);

    session.flush();
    await settle();

    expect(callbacks.onFlushed).toHaveBeenCalledTimes(1);
    expect(plugin.finish).not.toHaveBeenCalled();
    expect(callbacks.onTranscript).not.toHaveBeenCalled();

    expect(plugin.cancel).toHaveBeenCalledTimes(1);
    start.resolve();
    await settle();

    expect(plugin.cancel).toHaveBeenCalledTimes(2);
    expect(callbacks.onReady).not.toHaveBeenCalled();
  });

  it("cancels on close and raises nothing for a native answer that arrives after", async () => {
    const finish = deferred<{ readonly text: string }>();
    const plugin = fakePlugin({ finish: vi.fn(() => finish.promise) });
    const { session, callbacks } = openSession(plugin);
    await settle();
    session.flush();

    session.close();
    expect(plugin.cancel).toHaveBeenCalledWith({ sessionId: "1" });

    finish.resolve({ text: "too late" });
    await settle();

    expect(callbacks.onTranscript).not.toHaveBeenCalled();
    expect(callbacks.onFlushed).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
  });
});
