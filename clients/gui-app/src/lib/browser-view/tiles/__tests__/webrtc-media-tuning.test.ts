import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VIEWER_CONTROL_PLANE_DEADLINES } from "@/lib/browser-view/sessions/control-plane-deadlines";
import {
  applyAdaptiveJitterBufferTarget,
  createBrowserMediaPeer,
  preferH264IfCapable,
  type MediaPeerHandlers,
} from "../webrtc-media-registry";

/**
 * A minimal `RTCStatsReport`-shaped report: one inbound-rtp video stat. The
 * WebRTC stats spec reports `jitter` in SECONDS - same convention
 * `mapWebrtcVideoStats` reads - so callers pass seconds, not milliseconds.
 */
function statsReport(jitterSeconds: number | null): RTCStatsReport {
  const entries: [string, Record<string, unknown>][] =
    jitterSeconds === null
      ? []
      : [
          [
            "inbound-1",
            { type: "inbound-rtp", kind: "video", jitter: jitterSeconds },
          ],
        ];
  return new Map(entries);
}

/** jsdom has no `RTCRtpReceiver`; only the field this module reads travels. */
function fakeReceiver(jitterBufferTargetPresent: boolean): RTCRtpReceiver {
  const partial = jitterBufferTargetPresent ? { jitterBufferTarget: null } : {};
  return partial as RTCRtpReceiver;
}

describe("applyAdaptiveJitterBufferTarget (A4/F6)", () => {
  it("sets the target to clamp(2 x jitterMs, 0, 200)", () => {
    const receiver = fakeReceiver(true);
    applyAdaptiveJitterBufferTarget(receiver, statsReport(0.04));
    expect(receiver.jitterBufferTarget).toBe(80);
  });

  it("clamps to the 200ms ceiling on a bad tail", () => {
    const receiver = fakeReceiver(true);
    applyAdaptiveJitterBufferTarget(receiver, statsReport(0.523));
    expect(receiver.jitterBufferTarget).toBe(200);
  });

  it("clamps to the 0ms floor on a negative reading", () => {
    const receiver = fakeReceiver(true);
    applyAdaptiveJitterBufferTarget(receiver, statsReport(-0.005));
    expect(receiver.jitterBufferTarget).toBe(0);
  });

  it("does nothing when the receiver lacks jitterBufferTarget (older engine)", () => {
    const receiver = fakeReceiver(false);
    applyAdaptiveJitterBufferTarget(receiver, statsReport(0.04));
    expect("jitterBufferTarget" in receiver).toBe(false);
  });

  it("does nothing when there is no receiver yet or no inbound-rtp sample", () => {
    const receiver = fakeReceiver(true);
    applyAdaptiveJitterBufferTarget(null, statsReport(0.04));
    applyAdaptiveJitterBufferTarget(receiver, statsReport(null));
    expect(receiver.jitterBufferTarget).toBeNull();
  });
});

describe("preferH264IfCapable (A4/F6, answerer-side only)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** jsdom has no `RTCPeerConnection`/`RTCRtpTransceiver`; only what the module reads travels. */
  function fakeConnection(
    transceivers: readonly RTCRtpTransceiver[],
  ): RTCPeerConnection {
    const partial: Pick<RTCPeerConnection, "getTransceivers"> = {
      getTransceivers: () => [...transceivers],
    };
    return partial as RTCPeerConnection;
  }

  function fakeTransceiver(input: {
    readonly kind: string;
    readonly setCodecPreferences: ((codecs: RTCRtpCodec[]) => void) | null;
  }): RTCRtpTransceiver {
    const receiver = { track: { kind: input.kind } } as RTCRtpReceiver;
    const partial =
      input.setCodecPreferences === null
        ? { receiver }
        : { receiver, setCodecPreferences: input.setCodecPreferences };
    return partial as RTCRtpTransceiver;
  }

  const VP8: RTCRtpCodec = { clockRate: 90000, mimeType: "video/VP8" };
  const H264: RTCRtpCodec = { clockRate: 90000, mimeType: "video/H264" };

  it("orders H.264 first when this engine and the offer both support it", () => {
    vi.stubGlobal("RTCRtpReceiver", {
      getCapabilities: () => ({
        codecs: [VP8, H264],
        headerExtensions: [],
      }),
    });
    const preferences: RTCRtpCodec[][] = [];
    const connection = fakeConnection([
      fakeTransceiver({
        kind: "video",
        setCodecPreferences: (codecs) => preferences.push(codecs),
      }),
    ]);

    preferH264IfCapable(
      connection,
      "m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 H264/90000\r\n",
    );

    expect(preferences).toEqual([[H264, VP8]]);
  });

  it("leaves VP8 as the floor when the offer never carried an H.264 payload", () => {
    vi.stubGlobal("RTCRtpReceiver", {
      getCapabilities: () => ({ codecs: [VP8, H264], headerExtensions: [] }),
    });
    const preferences: RTCRtpCodec[][] = [];
    const connection = fakeConnection([
      fakeTransceiver({
        kind: "video",
        setCodecPreferences: (codecs) => preferences.push(codecs),
      }),
    ]);

    preferH264IfCapable(
      connection,
      "m=video 9 UDP/TLS/RTP/SAVPF 97\r\na=rtpmap:97 VP8/90000\r\n",
    );

    expect(preferences).toEqual([]);
  });

  it("leaves VP8 as the floor when this engine cannot decode H.264", () => {
    vi.stubGlobal("RTCRtpReceiver", {
      getCapabilities: () => ({ codecs: [VP8], headerExtensions: [] }),
    });
    const preferences: RTCRtpCodec[][] = [];
    const connection = fakeConnection([
      fakeTransceiver({
        kind: "video",
        setCodecPreferences: (codecs) => preferences.push(codecs),
      }),
    ]);

    preferH264IfCapable(connection, "a=rtpmap:96 H264/90000\r\n");

    expect(preferences).toEqual([]);
  });

  it("skips a transceiver without setCodecPreferences (older engine) instead of throwing", () => {
    vi.stubGlobal("RTCRtpReceiver", {
      getCapabilities: () => ({ codecs: [VP8, H264], headerExtensions: [] }),
    });
    const connection = fakeConnection([
      fakeTransceiver({ kind: "video", setCodecPreferences: null }),
    ]);

    expect(() =>
      preferH264IfCapable(connection, "a=rtpmap:96 H264/90000\r\n"),
    ).not.toThrow();
  });

  it("never touches the audio transceiver", () => {
    vi.stubGlobal("RTCRtpReceiver", {
      getCapabilities: () => ({ codecs: [VP8, H264], headerExtensions: [] }),
    });
    const preferences: RTCRtpCodec[][] = [];
    const connection = fakeConnection([
      fakeTransceiver({
        kind: "audio",
        setCodecPreferences: (codecs) => preferences.push(codecs),
      }),
    ]);

    preferH264IfCapable(connection, "a=rtpmap:96 H264/90000\r\n");

    expect(preferences).toEqual([]);
  });
});

/**
 * jsdom has no `RTCPeerConnection`; stood in as the GLOBAL constructor
 * (`vi.stubGlobal`) so `createBrowserMediaPeer`'s own `new RTCPeerConnection`
 * picks it up. Only what these tests actually drive is modeled: the
 * negotiation methods (for the minor-8 order pin) and `connectionState` +
 * `onconnectionstatechange` (for the blocker-2 grace timer).
 */
class FakeConnection {
  readonly calls: string[] = [];
  connectionState = "new";
  localDescription: { sdp: string } | null = null;
  onconnectionstatechange: (() => void) | null = null;

  setRemoteDescription(): Promise<void> {
    this.calls.push("setRemoteDescription");
    return Promise.resolve();
  }

  getTransceivers(): unknown[] {
    this.calls.push("getTransceivers");
    return [];
  }

  createAnswer(): Promise<{ type: "answer"; sdp: string }> {
    this.calls.push("createAnswer");
    return Promise.resolve({ type: "answer", sdp: "answer-sdp" });
  }

  setLocalDescription(desc: { sdp: string }): Promise<void> {
    this.calls.push("setLocalDescription");
    this.localDescription = desc;
    return Promise.resolve();
  }

  addIceCandidate(): Promise<void> {
    return Promise.resolve();
  }

  getStats(): Promise<RTCStatsReport> {
    return Promise.resolve(new Map());
  }

  close(): void {}

  /** Mimics the browser dispatching the event after a state write. */
  setConnectionState(state: string): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

const NOOP_HANDLERS: MediaPeerHandlers = {
  onLocalIceCandidate: () => {},
  onIceGatheringComplete: () => {},
  onStream: () => {},
  onDataChannel: () => {},
  onFailure: () => {},
};

/** Stubs the global constructor and returns the instance it will produce. */
function stubPeerConnection(): FakeConnection {
  const instance = new FakeConnection();
  vi.stubGlobal(
    "RTCPeerConnection",
    function FakeRTCPeerConnection(): FakeConnection {
      return instance;
    },
  );
  return instance;
}

describe("createBrowserMediaPeer.answerOffer codec-order pin (minor 8)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs setRemoteDescription -> preferH264IfCapable -> createAnswer -> setLocalDescription, in order", async () => {
    vi.stubGlobal("RTCRtpReceiver", {
      getCapabilities: () => ({
        codecs: [{ clockRate: 90000, mimeType: "video/H264" }],
        headerExtensions: [],
      }),
    });
    const connection = stubPeerConnection();

    const peer = createBrowserMediaPeer(NOOP_HANDLERS, []);
    await peer.answerOffer("a=rtpmap:96 H264/90000\r\n");

    // `getTransceivers` is `preferH264IfCapable`'s only observable call on
    // this fake (it finds no video transceiver to touch and returns) - its
    // position between `setRemoteDescription` and `createAnswer` is the
    // order the review asked to pin.
    expect(connection.calls).toEqual([
      "setRemoteDescription",
      "getTransceivers",
      "createAnswer",
      "setLocalDescription",
    ]);
  });
});

describe("createBrowserMediaPeer connectionState 'failed' grace (blocker 2)", () => {
  const GRACE_MS = VIEWER_CONTROL_PLANE_DEADLINES.firstFrame.floorMs;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("does not report failure the instant connectionState reads 'failed'", () => {
    const connection = stubPeerConnection();
    const failures: string[] = [];
    createBrowserMediaPeer(
      { ...NOOP_HANDLERS, onFailure: (reason) => failures.push(reason) },
      [],
    );

    connection.setConnectionState("failed");
    expect(failures).toEqual([]);
  });

  it("reports failure only after the grace period elapses with no recovery", () => {
    const connection = stubPeerConnection();
    const failures: string[] = [];
    createBrowserMediaPeer(
      { ...NOOP_HANDLERS, onFailure: (reason) => failures.push(reason) },
      [],
    );

    connection.setConnectionState("failed");
    vi.advanceTimersByTime(GRACE_MS - 1);
    expect(failures).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(failures).toEqual(["connection-failed"]);
  });

  it("cancels the grace timer when the connection recovers (a same-id restart landing)", () => {
    const connection = stubPeerConnection();
    const failures: string[] = [];
    createBrowserMediaPeer(
      { ...NOOP_HANDLERS, onFailure: (reason) => failures.push(reason) },
      [],
    );

    connection.setConnectionState("failed");
    vi.advanceTimersByTime(GRACE_MS / 2);
    connection.setConnectionState("connected");

    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(failures).toEqual([]);
  });

  it("treats 'closed' as immediately terminal, unlike 'failed'", () => {
    const connection = stubPeerConnection();
    const failures: string[] = [];
    createBrowserMediaPeer(
      { ...NOOP_HANDLERS, onFailure: (reason) => failures.push(reason) },
      [],
    );

    connection.setConnectionState("closed");
    expect(failures).toEqual(["connection-closed"]);
  });

  it("closing while a failure grace timer is armed reports once, not twice", () => {
    const connection = stubPeerConnection();
    const failures: string[] = [];
    createBrowserMediaPeer(
      { ...NOOP_HANDLERS, onFailure: (reason) => failures.push(reason) },
      [],
    );

    connection.setConnectionState("failed");
    connection.setConnectionState("closed");
    vi.advanceTimersByTime(GRACE_MS * 2);

    expect(failures).toEqual(["connection-closed"]);
  });
});
