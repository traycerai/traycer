import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SimulatorStreamConfig } from "@traycer/protocol/host/simulator/stream-contracts";
import {
  FakeStreamClient,
  FakeStreamSession,
} from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import type { StatusChangeHandler } from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  createSimulatorStreamController,
  SIMULATOR_CANNOT_DECODE_MESSAGE,
  SIMULATOR_FIRST_FRAME_TIMEOUT_MS,
  SIMULATOR_HOST_TOO_OLD_MESSAGE,
  SIMULATOR_NO_VIDEO_MESSAGE,
  SIMULATOR_STALL_GAP_FRAME_INTERVALS,
  SIMULATOR_STREAM_RETRY_DELAY_MS,
  prefersMjpegFirst,
  type SimulatorStreamController,
  type SimulatorStreamState,
} from "../simulator-stream-controller";
import { setMobileAppPlatform } from "@/lib/mobile-app";
import { SOFT_DECODE_QUEUE } from "../simulator-decoder";
import {
  ANNEX_B_DELTA,
  ANNEX_B_KEYFRAME,
  AVCC_DESCRIPTION,
  fakeCodecRuntime,
  flushAsync,
  recordingSink,
  semuPacket,
  type FakeCodecRuntime,
  type RecordingSink,
} from "./simulator-codec-fixtures";

/**
 * A session whose fatal close carries the CODE a test names. The shared fake's
 * `emitFatal` always says `UNAUTHORIZED`, and the controller's retry decision
 * hangs on the code, so this one keeps the status handler to drive it.
 */
class CodedStreamSession extends FakeStreamSession {
  private handler: StatusChangeHandler | null = null;

  override onStatusChange(handler: StatusChangeHandler): void {
    this.handler = handler;
    super.onStatusChange(handler);
  }

  emitFatalCode(code: string, reason: string): void {
    this.handler?.(
      "closed",
      {
        kind: "fatalError",
        details: {
          code,
          reason,
          incompatibleMethods:
            code === "INCOMPATIBLE"
              ? [
                  {
                    method: "simulator.stream",
                    clientCanonical: null,
                    hostCanonical: null,
                    blocking: "host-missing-method",
                  },
                ]
              : null,
          upgradeGuidance: null,
        },
      },
      null,
      null,
    );
  }
}

class CodedStreamClient extends FakeStreamClient {
  override subscribe(method: string, params: unknown): CodedStreamSession {
    const session = new CodedStreamSession();
    this.sessions.push(session);
    this.subscribes.push({ method, params });
    session.emitStatus("open");
    return session;
  }
}

const EPIC = "epic-1";
const UDID = "udid-1";

const IOS_CONFIG: SimulatorStreamConfig = {
  platform: "ios",
  codec: "avcc",
  width: 1179,
  height: 2556,
  orientation: "portrait",
  inputAvailable: true,
  frameIntervalMs: 200,
};

interface Harness {
  readonly client: CodedStreamClient;
  readonly codec: FakeCodecRuntime;
  readonly sink: RecordingSink;
  readonly controller: SimulatorStreamController;
  readonly states: SimulatorStreamState[];
  readonly session: () => CodedStreamSession;
}

/** Like {@link CodedStreamClient}, but its sessions have not opened yet. */
class UnopenedStreamClient extends CodedStreamClient {
  override subscribe(method: string, params: unknown): CodedStreamSession {
    const session = new CodedStreamSession();
    this.sessions.push(session);
    this.subscribes.push({ method, params });
    return session;
  }
}

function harness(
  platform: "ios" | "android",
  supported: boolean,
  preferMjpeg: boolean,
): Harness {
  return harnessOn(
    new CodedStreamClient(true),
    platform,
    supported,
    preferMjpeg,
  );
}

function harnessOn(
  client: CodedStreamClient,
  platform: "ios" | "android",
  supported: boolean,
  preferMjpeg: boolean,
): Harness {
  const codec = fakeCodecRuntime(supported);
  const sink = recordingSink();
  const states: SimulatorStreamState[] = [];
  const controller = createSimulatorStreamController({
    epicId: EPIC,
    simulatorId: UDID,
    platform,
    client,
    sink,
    preferMjpeg,
    decoderRuntime: codec.runtime,
  });
  controller.subscribe(() => {
    states.push(controller.getState());
  });
  return {
    client,
    codec,
    sink,
    controller,
    states,
    session: () => {
      const session = client.sessions.at(-1);
      if (!(session instanceof CodedStreamSession)) {
        throw new Error("expected a simulator.stream session");
      }
      return session;
    },
  };
}

function emitConfig(
  session: FakeStreamSession,
  config: SimulatorStreamConfig,
): void {
  session.emit({ kind: "streamConfig", hasBinaryPayload: false, config }, null);
}

function emitVideo(
  session: FakeStreamSession,
  unit: string,
  bytes: Uint8Array,
): void {
  session.emit({ kind: "video", hasBinaryPayload: true, unit }, bytes);
}

beforeEach(() => {
  vi.useFakeTimers();
  // The controller reads WebCodecs availability off the globals, and jsdom
  // has none; the fake runtime is what actually decodes.
  vi.stubGlobal("VideoDecoder", class {});
  vi.stubGlobal("EncodedVideoChunk", class {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("simulator stream controller", () => {
  it("opens the stream for the epic's simulator, decodes by unit and reports streaming on the first frame", async () => {
    const h = harness("ios", true, false);
    h.controller.start();
    expect(h.client.subscribes).toEqual([
      {
        method: "simulator.stream",
        params: { epicId: EPIC, simulatorId: UDID },
      },
    ]);
    expect(h.controller.getState().lifecycle).toBe("connecting");

    emitConfig(h.session(), IOS_CONFIG);
    expect(h.controller.getState().config).toEqual(IOS_CONFIG);
    expect(h.controller.getState().plane).toBe("canvas");

    emitVideo(h.session(), "description", AVCC_DESCRIPTION);
    await flushAsync();
    emitVideo(h.session(), "keyframe", ANNEX_B_KEYFRAME);
    expect(h.codec.decoders[0].chunks.map((c) => c.type)).toEqual(["key"]);

    h.codec.decoders[0].emitFrame(1179, 2556);
    expect(h.controller.getState()).toMatchObject({
      lifecycle: "streaming",
      frameSize: { width: 1179, height: 2556 },
    });
    expect(h.sink.painted).toEqual([{ width: 1179, height: 2556 }]);

    // Input is withheld until the host says this viewer may drive.
    h.controller.sendTouch("begin", { x: 0.5, y: 0.25 });
    expect(h.session().framesOfKind("touch")).toHaveLength(0);
    h.session().emit(
      {
        kind: "inputState",
        hasBinaryPayload: false,
        connected: true,
        detail: null,
      },
      null,
    );
    h.controller.sendTouch("begin", { x: 0.5, y: 0.25 });
    h.controller.sendKey(
      {
        key: "a",
        code: "KeyA",
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
      },
      "down",
    );
    h.controller.pressButton("home");
    h.controller.rotate();
    expect(h.session().framesOfKind("touch")).toEqual([
      {
        kind: "touch",
        hasBinaryPayload: false,
        phase: "begin",
        x: 0.5,
        y: 0.25,
      },
    ]);
    expect(h.session().framesOfKind("key")).toHaveLength(1);
    expect(h.session().framesOfKind("button")).toEqual([
      { kind: "button", hasBinaryPayload: false, button: "home" },
    ]);
    expect(h.session().framesOfKind("orientation")).toEqual([
      {
        kind: "orientation",
        hasBinaryPayload: false,
        orientation: "landscape_left",
      },
    ]);

    h.controller.stop();
    expect(h.session().closed).toBe(true);
    expect(h.controller.getState().lifecycle).toBe("idle");
  });

  it("sends an ask that fell inside the floor when the floor ends, and drops it on close", async () => {
    const h = harness("ios", true, false);
    h.controller.start();
    emitConfig(h.session(), IOS_CONFIG);
    emitVideo(h.session(), "description", AVCC_DESCRIPTION);
    await flushAsync();
    emitVideo(h.session(), "keyframe", ANNEX_B_KEYFRAME);
    h.codec.decoders[0].decodeQueueSize = SOFT_DECODE_QUEUE + 1;
    emitVideo(h.session(), "delta", ANNEX_B_DELTA);
    expect(h.session().framesOfKind("requestKeyframe")).toHaveLength(1);
    // The decoder asks once per gap; the next gap's one ask lands 400 ms
    // later, inside the floor. It must reach the hub when the floor ends,
    // not never.
    vi.advanceTimersByTime(400);
    emitVideo(h.session(), "keyframe", ANNEX_B_KEYFRAME);
    h.codec.decoders[1].decodeQueueSize = SOFT_DECODE_QUEUE + 1;
    emitVideo(h.session(), "delta", ANNEX_B_DELTA);
    expect(h.session().framesOfKind("requestKeyframe")).toHaveLength(1);
    vi.advanceTimersByTime(599);
    expect(h.session().framesOfKind("requestKeyframe")).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(h.session().framesOfKind("requestKeyframe")).toHaveLength(2);
    // A held ask does not outlive the stream.
    emitVideo(h.session(), "keyframe", ANNEX_B_KEYFRAME);
    h.codec.decoders[2].decodeQueueSize = SOFT_DECODE_QUEUE + 1;
    emitVideo(h.session(), "delta", ANNEX_B_DELTA);
    expect(h.session().framesOfKind("requestKeyframe")).toHaveLength(2);
    h.controller.stop();
    vi.advanceTimersByTime(2_000);
    expect(h.session().framesOfKind("requestKeyframe")).toHaveLength(2);
  });

  it("falls back to MJPEG on iOS when the profile is rejected, and paints JPEG frames on the image plane", async () => {
    const h = harness("ios", false, false);
    h.controller.start();
    emitConfig(h.session(), IOS_CONFIG);
    emitVideo(h.session(), "description", AVCC_DESCRIPTION);
    await flushAsync();
    expect(h.session().framesOfKind("preferMjpeg")).toHaveLength(1);
    // Units of the old codec that are still in flight are dropped.
    emitVideo(h.session(), "keyframe", ANNEX_B_KEYFRAME);
    expect(h.codec.decoders).toHaveLength(0);

    emitConfig(h.session(), { ...IOS_CONFIG, codec: "mjpeg" });
    expect(h.controller.getState().plane).toBe("image");
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    emitVideo(h.session(), "jpeg", jpeg);
    expect(h.sink.jpegs).toEqual([jpeg]);
    expect(h.controller.getState().lifecycle).toBe("streaming");
  });

  describe("on the installed iOS app", () => {
    afterEach(() => {
      setMobileAppPlatform(null);
    });

    it("asks for MJPEG before anything else and never probes the H.264 config the host opens with", async () => {
      setMobileAppPlatform("ios");
      const h = harness("ios", true, prefersMjpegFirst());
      h.controller.start();
      expect(h.session().sentFrames[0]?.kind).toBe("preferMjpeg");
      expect(h.session().framesOfKind("preferMjpeg")).toHaveLength(1);

      emitConfig(h.session(), IOS_CONFIG);
      emitVideo(h.session(), "description", AVCC_DESCRIPTION);
      emitVideo(h.session(), "keyframe", ANNEX_B_KEYFRAME);
      await flushAsync();
      expect(h.codec.probes).toEqual([]);
      expect(h.codec.decoders).toEqual([]);

      emitConfig(h.session(), { ...IOS_CONFIG, codec: "mjpeg" });
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
      emitVideo(h.session(), "jpeg", jpeg);
      expect(h.controller.getState()).toMatchObject({
        plane: "image",
        lifecycle: "streaming",
      });
      expect(h.sink.jpegs).toEqual([jpeg]);
    });

    it.each<{ readonly platform: "android" | null }>([
      { platform: "android" },
      { platform: null },
    ])(
      "probes the profile first when the app platform is $platform",
      async ({ platform }) => {
        setMobileAppPlatform(platform);
        expect(prefersMjpegFirst()).toBe(false);
        const h = harness("ios", true, prefersMjpegFirst());
        h.controller.start();
        emitConfig(h.session(), IOS_CONFIG);
        emitVideo(h.session(), "description", AVCC_DESCRIPTION);
        await flushAsync();
        expect(h.session().framesOfKind("preferMjpeg")).toHaveLength(0);
        expect(h.codec.probes).toHaveLength(1);
      },
    );

    it("asks for MJPEG again after a transport drop, because the re-declared subscription opens on H.264", () => {
      setMobileAppPlatform("ios");
      const h = harness("ios", true, prefersMjpegFirst());
      h.controller.start();
      expect(h.session().framesOfKind("preferMjpeg")).toHaveLength(1);

      h.session().emitStatus("reconnecting");
      h.session().emitStatus("open");
      expect(h.session().framesOfKind("preferMjpeg")).toHaveLength(2);
    });

    it("reads as streaming again on the first JPEG after a transport drop, and measures stalls again", () => {
      setMobileAppPlatform("ios");
      const h = harness("ios", true, prefersMjpegFirst());
      h.controller.start();
      const mjpeg = { ...IOS_CONFIG, codec: "mjpeg" } as const;
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
      emitConfig(h.session(), mjpeg);
      emitVideo(h.session(), "jpeg", jpeg);
      expect(h.controller.getState().lifecycle).toBe("streaming");

      h.session().emitStatus("reconnecting");
      expect(h.controller.getState().lifecycle).toBe("reconnecting");
      h.session().emitStatus("open");
      emitConfig(h.session(), mjpeg);
      emitVideo(h.session(), "jpeg", jpeg);
      expect(h.controller.getState()).toMatchObject({
        lifecycle: "streaming",
        plane: "image",
        stalled: false,
      });
      // IOS_CONFIG's hub sends a frame every 200 ms.
      vi.advanceTimersByTime(200 * SIMULATOR_STALL_GAP_FRAME_INTERVALS);
      expect(h.controller.getState().stalled).toBe(true);
    });

    it("gives up on an Android emulator after three decode errors in ten seconds instead of looping on keyframes", async () => {
      setMobileAppPlatform("ios");
      const h = harness("android", true, prefersMjpegFirst());
      h.controller.start();
      emitConfig(h.session(), {
        ...IOS_CONFIG,
        platform: "android",
        codec: "semu",
        width: null,
        height: null,
      });
      emitVideo(h.session(), "packet", semuPacket(ANNEX_B_KEYFRAME, true, 0));
      await flushAsync();
      expect(h.codec.decoders).toHaveLength(1);

      // Each error resets the decoder, so the next one lands on its successor.
      h.codec.decoders.at(-1)?.emitError("EncodingError");
      vi.advanceTimersByTime(2_000);
      h.codec.decoders.at(-1)?.emitError("EncodingError");
      expect(h.controller.getState().lifecycle).not.toBe("error");
      expect(h.codec.decoders).toHaveLength(3);

      vi.advanceTimersByTime(2_000);
      h.codec.decoders.at(-1)?.emitError("EncodingError");
      expect(h.controller.getState()).toMatchObject({
        lifecycle: "error",
        terminal: true,
        detail: SIMULATOR_CANNOT_DECODE_MESSAGE,
      });
      expect(h.session().closed).toBe(true);
      expect(h.session().framesOfKind("preferMjpeg")).toHaveLength(0);
    });

    it("shows 'cannot decode' without opening a stream for an Android emulator when WebCodecs is missing", () => {
      setMobileAppPlatform("ios");
      // `isWebCodecsSupported` looks for the keys, and jsdom defines neither.
      vi.unstubAllGlobals();
      const h = harness("android", true, prefersMjpegFirst());
      h.controller.start();
      expect(h.controller.getState()).toMatchObject({
        lifecycle: "error",
        terminal: true,
        detail: SIMULATOR_CANNOT_DECODE_MESSAGE,
      });
      expect(h.states.length).toBeGreaterThan(0);
      expect(h.states.map((state) => state.lifecycle)).not.toContain(
        "connecting",
      );
      expect(h.client.subscribes).toEqual([]);
    });
  });

  it("stops with a terminal error on Android when the profile is rejected", async () => {
    const h = harness("android", false, false);
    h.controller.start();
    emitConfig(h.session(), {
      ...IOS_CONFIG,
      platform: "android",
      codec: "semu",
      width: null,
      height: null,
    });
    emitVideo(h.session(), "packet", semuPacket(ANNEX_B_KEYFRAME, true, 0));
    await flushAsync();
    expect(h.controller.getState()).toMatchObject({
      lifecycle: "error",
      terminal: true,
      detail: SIMULATOR_CANNOT_DECODE_MESSAGE,
    });
    expect(h.session().closed).toBe(true);
  });

  it("gives up after the first-frame window with a Reconnect, and restart opens a new stream", () => {
    const h = harness("ios", true, false);
    h.controller.start();
    emitConfig(h.session(), IOS_CONFIG);
    vi.advanceTimersByTime(SIMULATOR_FIRST_FRAME_TIMEOUT_MS);
    expect(h.controller.getState()).toMatchObject({
      lifecycle: "error",
      terminal: false,
      detail: SIMULATOR_NO_VIDEO_MESSAGE,
    });
    expect(h.client.sessions[0].closed).toBe(true);

    h.controller.restart();
    expect(h.client.sessions).toHaveLength(2);
    expect(h.controller.getState().lifecycle).toBe("connecting");
  });

  it("retries a retryable refusal after one second and keeps the last frame meanwhile", async () => {
    const h = harness("ios", true, false);
    h.controller.start();
    emitConfig(h.session(), IOS_CONFIG);
    emitVideo(h.session(), "description", AVCC_DESCRIPTION);
    await flushAsync();
    emitVideo(h.session(), "keyframe", ANNEX_B_KEYFRAME);
    h.codec.decoders[0].emitFrame(1179, 2556);

    h.session().emit(
      { kind: "error", hasBinaryPayload: false, reason: "hub is restarting" },
      null,
    );
    h.session().emitFatalCode("SIMULATOR_INIT_FAILED", "init failed");
    expect(h.controller.getState()).toMatchObject({
      lifecycle: "reconnecting",
      detail: "hub is restarting",
      frameSize: { width: 1179, height: 2556 },
    });
    expect(h.client.sessions).toHaveLength(1);
    vi.advanceTimersByTime(SIMULATOR_STREAM_RETRY_DELAY_MS);
    expect(h.client.sessions).toHaveLength(2);
    expect(h.controller.getState().lifecycle).toBe("connecting");
  });

  it("goes terminal when the host is too old to serve the stream", () => {
    const h = harness("ios", true, false);
    h.controller.start();
    h.session().emitFatalCode("INCOMPATIBLE", "simulator.stream unknown");
    expect(h.controller.getState()).toMatchObject({
      lifecycle: "error",
      terminal: true,
      detail: SIMULATOR_HOST_TOO_OLD_MESSAGE,
    });
    vi.advanceTimersByTime(SIMULATOR_STREAM_RETRY_DELAY_MS * 5);
    expect(h.client.sessions).toHaveLength(1);
  });

  it("goes terminal, with no retry, when the session is gone", () => {
    const h = harness("ios", true, false);
    h.controller.start();
    h.session().emitFatalCode("SIMULATOR_SESSION_CLOSED", "closed");
    expect(h.controller.getState()).toMatchObject({
      lifecycle: "error",
      terminal: true,
      detail: "This simulator was closed.",
    });
    vi.advanceTimersByTime(SIMULATOR_STREAM_RETRY_DELAY_MS * 5);
    expect(h.client.sessions).toHaveLength(1);
  });

  it("reads a transport drop as reconnecting and waits for a keyframe again", async () => {
    const h = harness("ios", true, false);
    h.controller.start();
    emitConfig(h.session(), IOS_CONFIG);
    emitVideo(h.session(), "description", AVCC_DESCRIPTION);
    await flushAsync();
    emitVideo(h.session(), "keyframe", ANNEX_B_KEYFRAME);
    h.codec.decoders[0].emitFrame(1179, 2556);
    h.session().emitStatus("reconnecting");
    expect(h.controller.getState().lifecycle).toBe("reconnecting");
    h.session().emitStatus("open");
    // The re-declared subscription starts over from the host: a delta
    // before the fresh keyframe is dropped.
    emitVideo(h.session(), "delta", ANNEX_B_DELTA);
    expect(h.codec.decoders.at(-1)?.chunks).toHaveLength(0);
    emitVideo(h.session(), "keyframe", ANNEX_B_KEYFRAME);
    h.codec.decoders.at(-1)?.emitFrame(1179, 2556);
    expect(h.controller.getState().lifecycle).toBe("streaming");
  });

  describe("while the host holds the stream", () => {
    async function streamingH264(): Promise<Harness> {
      const h = harness("ios", true, false);
      h.controller.start();
      emitConfig(h.session(), IOS_CONFIG);
      emitVideo(h.session(), "description", AVCC_DESCRIPTION);
      await flushAsync();
      emitVideo(h.session(), "keyframe", ANNEX_B_KEYFRAME);
      h.codec.decoders[0].emitFrame(1179, 2556);
      expect(h.controller.getState().lifecycle).toBe("streaming");
      return h;
    }

    it("reads as reconnecting while held, then streams on the same decoder after a continued open with no new keyframe", async () => {
      const h = await streamingH264();

      h.session().emitContinuityStatus("reconnecting", "held");
      expect(h.controller.getState()).toMatchObject({
        lifecycle: "reconnecting",
        stalled: false,
      });
      expect(h.controller.getState().input.connected).toBe(false);

      h.session().emitContinuityStatus("open", "continued");
      expect(h.controller.getState()).toMatchObject({
        lifecycle: "streaming",
        stalled: false,
      });
      // The host never restarts the unit stream, so a delta is decodable.
      emitVideo(h.session(), "delta", ANNEX_B_DELTA);
      expect(h.codec.decoders).toHaveLength(1);
      expect(h.codec.decoders[0].chunks).toHaveLength(2);
      expect(h.client.sessions).toHaveLength(1);
    });

    it("keeps the MJPEG plane across a held drop and a continued open", () => {
      setMobileAppPlatform("ios");
      const h = harness("ios", true, prefersMjpegFirst());
      h.controller.start();
      const mjpeg = { ...IOS_CONFIG, codec: "mjpeg" } as const;
      emitConfig(h.session(), mjpeg);
      emitVideo(h.session(), "jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
      expect(h.controller.getState().plane).toBe("image");

      h.session().emitContinuityStatus("reconnecting", "held");
      expect(h.controller.getState().lifecycle).toBe("reconnecting");
      h.session().emitContinuityStatus("open", "continued");

      expect(h.controller.getState()).toMatchObject({
        lifecycle: "streaming",
        plane: "image",
      });
    });

    describe("held on the initial subscribe, before the transport's first frame", () => {
      function unopened(): Harness {
        return harnessOn(new UnopenedStreamClient(true), "ios", true, false);
      }

      it("reads streaming on the first frame once the stream opens", async () => {
        const h = unopened();
        h.controller.start();

        h.session().emitContinuityStatus("reconnecting", "held");
        h.session().emitContinuityStatus("open", null);
        emitConfig(h.session(), IOS_CONFIG);
        emitVideo(h.session(), "description", AVCC_DESCRIPTION);
        await flushAsync();
        emitVideo(h.session(), "keyframe", ANNEX_B_KEYFRAME);
        h.codec.decoders.at(-1)?.emitFrame(1179, 2556);

        expect(h.controller.getState().lifecycle).toBe("streaming");
      });

      it("keeps the first-frame window running once the stream opens", () => {
        const h = unopened();
        h.controller.start();

        h.session().emitContinuityStatus("reconnecting", "held");
        h.session().emitContinuityStatus("open", null);
        vi.advanceTimersByTime(SIMULATOR_FIRST_FRAME_TIMEOUT_MS);

        expect(h.controller.getState()).toMatchObject({
          lifecycle: "error",
          detail: SIMULATOR_NO_VIDEO_MESSAGE,
        });
      });
    });

    describe("held after a plain reconnect, before the new cycle's first frame", () => {
      it("reads streaming on the new cycle's first frame instead of staying masked as reconnecting", async () => {
        const h = await streamingH264();

        h.session().emitStatus("reconnecting");
        h.session().emitContinuityStatus("reconnecting", "held");
        h.session().emitContinuityStatus("open", null);
        emitConfig(h.session(), IOS_CONFIG);
        emitVideo(h.session(), "description", AVCC_DESCRIPTION);
        await flushAsync();
        emitVideo(h.session(), "keyframe", ANNEX_B_KEYFRAME);
        h.codec.decoders.at(-1)?.emitFrame(1179, 2556);

        expect(h.controller.getState().lifecycle).toBe("streaming");
      });

      it("rearms the first-frame window for the new cycle", async () => {
        const h = await streamingH264();

        h.session().emitStatus("reconnecting");
        h.session().emitContinuityStatus("reconnecting", "held");
        h.session().emitContinuityStatus("open", null);
        vi.advanceTimersByTime(SIMULATOR_FIRST_FRAME_TIMEOUT_MS);

        expect(h.controller.getState()).toMatchObject({
          lifecycle: "error",
          detail: SIMULATOR_NO_VIDEO_MESSAGE,
        });
      });
    });

    it("waits for a fresh keyframe once the hold ends", async () => {
      const h = await streamingH264();

      h.session().emitContinuityStatus("reconnecting", "held");
      h.session().emitContinuityStatus("reconnecting", null);
      h.session().emitContinuityStatus("open", null);
      emitVideo(h.session(), "delta", ANNEX_B_DELTA);
      expect(h.codec.decoders.at(-1)?.chunks).toHaveLength(0);

      emitVideo(h.session(), "keyframe", ANNEX_B_KEYFRAME);
      h.codec.decoders.at(-1)?.emitFrame(1179, 2556);
      expect(h.controller.getState().lifecycle).toBe("streaming");
    });
  });

  describe("a quiet hub", () => {
    const GAP_MS = 200 * SIMULATOR_STALL_GAP_FRAME_INTERVALS;

    async function streamingHarness(
      config: SimulatorStreamConfig,
    ): Promise<Harness> {
      const h = harness("ios", true, false);
      h.controller.start();
      emitConfig(h.session(), config);
      emitVideo(h.session(), "description", AVCC_DESCRIPTION);
      await flushAsync();
      emitVideo(h.session(), "keyframe", ANNEX_B_KEYFRAME);
      h.codec.decoders[0].emitFrame(1179, 2556);
      expect(h.controller.getState()).toMatchObject({
        lifecycle: "streaming",
        stalled: false,
      });
      return h;
    }

    it("reads as stalled after five of the hub's frame intervals without a frame, and the next frame clears it", async () => {
      const h = await streamingHarness(IOS_CONFIG);
      vi.advanceTimersByTime(GAP_MS - 1);
      expect(h.controller.getState().stalled).toBe(false);
      vi.advanceTimersByTime(1);
      expect(h.controller.getState()).toMatchObject({
        lifecycle: "streaming",
        stalled: true,
      });
      // Still streaming: input keeps flowing, the last frame stays painted.
      expect(h.sink.painted).toHaveLength(1);

      h.codec.decoders[0].emitFrame(1179, 2556);
      expect(h.controller.getState().stalled).toBe(false);
      // Every frame starts the clock over.
      vi.advanceTimersByTime(GAP_MS - 1);
      h.codec.decoders[0].emitFrame(1179, 2556);
      vi.advanceTimersByTime(GAP_MS - 1);
      expect(h.controller.getState().stalled).toBe(false);

      h.controller.stop();
      vi.advanceTimersByTime(GAP_MS * 2);
      expect(h.controller.getState()).toMatchObject({
        lifecycle: "idle",
        stalled: false,
      });
    });

    it("never reads as stalled while the hub does not say how often it sends frames", async () => {
      const h = await streamingHarness({
        ...IOS_CONFIG,
        frameIntervalMs: null,
      });
      vi.advanceTimersByTime(GAP_MS * 20);
      expect(h.controller.getState().stalled).toBe(false);
    });

    it("drops the stall with the stream on a transport drop, and measures again once frames return", async () => {
      const h = await streamingHarness(IOS_CONFIG);
      vi.advanceTimersByTime(GAP_MS);
      expect(h.controller.getState().stalled).toBe(true);
      h.session().emitStatus("reconnecting");
      expect(h.controller.getState()).toMatchObject({
        lifecycle: "reconnecting",
        stalled: false,
      });
      vi.advanceTimersByTime(GAP_MS * 2);
      expect(h.controller.getState().stalled).toBe(false);
    });
  });
});
