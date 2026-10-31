import { describe, expect, it, vi, type Mock } from "vitest";
import type { VoiceEngineEvents } from "../engine";
import {
  createGptLiveEngine,
  type GptLiveDataChannel,
  type GptLivePeer,
} from "../gpt-live-engine";

interface FakeChannel extends GptLiveDataChannel {
  send: Mock<(data: string) => void>;
}

interface FakePeer extends GptLivePeer {
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

    engine.close();
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
