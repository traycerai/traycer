import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  VoiceEngineError,
  type VoiceEngineConnectInput,
  type VoiceEngineEvents,
} from "../engine";
import {
  SESSION_STARTED_TIMEOUT_MS,
  createGptLiveEngine,
  type GptLiveDataChannel,
  type GptLivePeer,
} from "../gpt-live-engine";

interface FakeChannel extends GptLiveDataChannel {
  readyState: RTCDataChannelState;
  send: Mock<(data: string) => void>;
}

interface FakePeer extends GptLivePeer {
  connectionState: RTCPeerConnectionState;
  setRemoteDescription: Mock<() => Promise<void>>;
  close: Mock<() => void>;
}

function setup() {
  const channel: FakeChannel = {
    readyState: "open",
    send: vi.fn<(data: string) => void>(),
    onmessage: null,
  };
  const peer: FakePeer = {
    iceGatheringState: "complete",
    connectionState: "connected",
    localDescription: { sdp: "local-offer" },
    ontrack: null,
    onconnectionstatechange: null,
    createDataChannel: () => channel,
    addTrack: () => undefined,
    createOffer: () => Promise.resolve({ type: "offer", sdp: "raw-offer" }),
    setLocalDescription: () => Promise.resolve(),
    setRemoteDescription: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    close: vi.fn<() => void>(),
  };
  const events = {
    onInputTranscriptDelta:
      vi.fn<VoiceEngineEvents["onInputTranscriptDelta"]>(),
    onOutputTranscriptDelta:
      vi.fn<VoiceEngineEvents["onOutputTranscriptDelta"]>(),
    onDelegationCreated: vi.fn<VoiceEngineEvents["onDelegationCreated"]>(),
    onUsage: vi.fn<VoiceEngineEvents["onUsage"]>(),
    onClosed: vi.fn<VoiceEngineEvents["onClosed"]>(),
  };
  const engine = createGptLiveEngine({
    createPeer: () => peer,
  });
  const exchangeSdp = vi.fn<(offer: string) => Promise<string>>(() =>
    Promise.resolve("the-answer"),
  );
  const push = (event: Record<string, unknown>): void => {
    channel.onmessage?.({
      data: JSON.stringify(event),
    } as MessageEvent<unknown>);
  };
  const connect = async (): Promise<void> => {
    const connecting = engine.connect({
      micTrack: { kind: "audio" } as MediaStreamTrack,
      exchangeSdp,
      onRemoteAudio: () => undefined,
      events,
    });
    // Let the offer exchange reach the wait for `session.started`.
    await vi.waitFor(() => {
      expect(peer.setRemoteDescription).toHaveBeenCalled();
    });
    push({ type: "session.started" });
    await connecting;
  };
  return { engine, channel, peer, events, exchangeSdp, push, connect };
}

describe("createGptLiveEngine", () => {
  it("exchanges the offer and resolves connect on session.started", async () => {
    const { exchangeSdp, peer, connect } = setup();

    await connect();

    expect(exchangeSdp).toHaveBeenCalledWith("local-offer");
    expect(peer.setRemoteDescription).toHaveBeenCalledWith({
      type: "answer",
      sdp: "the-answer",
    });
  });

  it("delivers transcript deltas, delegations and usage to the events", async () => {
    const { events, push, connect } = setup();
    await connect();

    push({ type: "session.input_transcript.delta", delta: "hel" });
    push({ type: "session.output_transcript.delta", delta: "hi" });
    push({ type: "session.delegation.created", delegation: { id: "d-1" } });
    push({
      type: "session.usage.updated",
      usage: { seconds: 12 },
      context_window: { usage_ratio: 0.4 },
    });

    expect(events.onInputTranscriptDelta).toHaveBeenCalledWith("hel");
    expect(events.onOutputTranscriptDelta).toHaveBeenCalledWith("hi");
    expect(events.onDelegationCreated).toHaveBeenCalledWith("d-1");
    expect(events.onUsage).toHaveBeenCalledWith({
      seconds: 12,
      contextUsageRatio: 0.4,
    });
  });

  it("sends commentary under the delegation id", async () => {
    const { engine, channel, connect } = setup();
    await connect();

    engine.appendCommentary("it is done", "d-1");

    expect(JSON.parse(channel.send.mock.calls[0]?.[0] ?? "")).toEqual({
      type: "session.commentary.append",
      delegation_id: "d-1",
      content: "it is done",
    });
  });

  it("close sends session.close and reports the app close once on session.closed", async () => {
    const { engine, channel, peer, events, push, connect } = setup();
    await connect();

    void engine.close();
    expect(JSON.parse(channel.send.mock.calls[0]?.[0] ?? "")).toEqual({
      type: "session.close",
    });
    expect(events.onClosed).not.toHaveBeenCalled();

    push({ type: "session.closed" });
    push({ type: "session.closed" });

    expect(events.onClosed).toHaveBeenCalledTimes(1);
    expect(events.onClosed).toHaveBeenCalledWith("app");
    expect(peer.close).toHaveBeenCalledTimes(1);
  });

  it("reports a vendor-initiated close as vendor", async () => {
    const { events, push, connect } = setup();
    await connect();

    push({ type: "session.closed" });

    expect(events.onClosed).toHaveBeenCalledWith("vendor");
  });

  it("rejects connect and reports failed when the exchange fails", async () => {
    const { engine, events, exchangeSdp } = setup();
    exchangeSdp.mockRejectedValueOnce(new Error("402"));

    await expect(
      engine.connect({
        micTrack: { kind: "audio" } as MediaStreamTrack,
        exchangeSdp,
        onRemoteAudio: () => undefined,
        events,
      }),
    ).rejects.toThrow("402");
    expect(events.onClosed).toHaveBeenCalledWith("failed");
  });
});

/** Lets every already-settled promise continuation run. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function connectInput(
  events: VoiceEngineEvents,
  exchangeSdp: (offer: string) => Promise<string>,
): VoiceEngineConnectInput {
  return {
    micTrack: { kind: "audio" } as MediaStreamTrack,
    exchangeSdp,
    onRemoteAudio: () => undefined,
    events,
  };
}

describe("createGptLiveEngine lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports app, not connection, when the peer fails while the app's close is pending", async () => {
    const t = setup();
    await t.connect();

    void t.engine.close();
    t.peer.connectionState = "failed";
    t.peer.onconnectionstatechange?.(new Event("connectionstatechange"));

    expect(t.events.onClosed).toHaveBeenCalledTimes(1);
    expect(t.events.onClosed).toHaveBeenCalledWith("app");
  });

  it("resolves close only after session.closed, with onClosed already fired", async () => {
    const t = setup();
    await t.connect();
    const order: string[] = [];
    t.events.onClosed.mockImplementation(() => order.push("closed"));

    const closing = t.engine.close().then(() => order.push("resolved"));
    await Promise.resolve();
    expect(order).toEqual([]);

    t.push({ type: "session.closed" });
    await closing;

    expect(order).toEqual(["closed", "resolved"]);
    expect(t.peer.close).toHaveBeenCalledTimes(1);
  });

  it("resolves close after the two second fallback when the vendor never confirms", async () => {
    vi.useFakeTimers();
    const t = setup();
    const connecting = t.engine.connect(connectInput(t.events, t.exchangeSdp));
    await flush();
    t.push({ type: "session.started" });
    await connecting;
    const order: string[] = [];
    t.events.onClosed.mockImplementation(() => order.push("closed"));

    const closing = t.engine.close().then(() => order.push("resolved"));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(order).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(order).toEqual(["closed", "resolved"]);
    expect(t.events.onClosed).toHaveBeenCalledWith("app");
  });

  it("rejects connect when the app closes during the exchange, without an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const t = setup();
      t.channel.readyState = "connecting";
      let answer: (sdp: string) => void = () => undefined;
      const exchange = vi.fn<(offer: string) => Promise<string>>(
        () =>
          new Promise<string>((resolve) => {
            answer = resolve;
          }),
      );
      const outcome = t.engine.connect(connectInput(t.events, exchange)).then(
        () => "resolved",
        (error: unknown) => error,
      );
      await vi.waitFor(() => {
        expect(exchange).toHaveBeenCalled();
      });

      await t.engine.close();
      answer("late-answer");
      const result = await outcome;

      expect(result).toBeInstanceOf(Error);
      expect(t.events.onClosed).toHaveBeenCalledTimes(1);
      expect(t.events.onClosed).toHaveBeenCalledWith("app");
      expect(t.peer.setRemoteDescription).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("rejects connect and reports failed when session.started never arrives", async () => {
    vi.useFakeTimers();
    const t = setup();
    const outcome = t.engine
      .connect(connectInput(t.events, t.exchangeSdp))
      .then(
        () => "resolved",
        (error: unknown) => error,
      );
    await flush();
    expect(t.peer.setRemoteDescription).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SESSION_STARTED_TIMEOUT_MS - 1);
    expect(t.events.onClosed).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBeInstanceOf(Error);
    expect(t.events.onClosed).toHaveBeenCalledTimes(1);
    expect(t.events.onClosed).toHaveBeenCalledWith("failed");
    expect(t.peer.close).toHaveBeenCalled();
  });

  it("delivers onClosed(failed) before connect rejects with the exchange's error as EXCHANGE_FAILED", async () => {
    const t = setup();
    const order: string[] = [];
    t.events.onClosed.mockImplementation((reason) =>
      order.push(`closed:${reason}`),
    );
    t.exchangeSdp.mockRejectedValueOnce(new Error("402"));

    const failure = await t.engine
      .connect(connectInput(t.events, t.exchangeSdp))
      .then(
        () => null,
        (error: unknown) => {
          order.push("rejected");
          return error;
        },
      );

    expect(order).toEqual(["closed:failed", "rejected"]);
    expect(failure).toBeInstanceOf(VoiceEngineError);
    expect(failure).toMatchObject({ code: "EXCHANGE_FAILED", message: "402" });
  });
});
