import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetHostConnectionRegistryForTest } from "@traycer-clients/shared/host-client/host-connection-registry";
import {
  FakeStreamClient,
  FakeStreamSession,
} from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import type {
  StatusChangeHandler,
  StreamCloseReason,
  StreamFrameEnvelope,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  createEnvironmentArmLanes,
  type EnvironmentArmFrame,
  type EnvironmentArmLaneSpec,
} from "../environment-arm-lanes";

type State = readonly string[];
type Frame = { readonly value: string };

/** A fake session that records reconnect requests and can close with any reason. */
class ArmSession extends FakeStreamSession {
  reconnects = 0;
  private closeHandler: StatusChangeHandler | null = null;

  override requestReconnect(): void {
    this.reconnects += 1;
  }

  override onStatusChange(handler: StatusChangeHandler): void {
    this.closeHandler = handler;
    super.onStatusChange(handler);
  }

  closeWith(reason: StreamCloseReason): void {
    this.closeHandler?.("closed", reason, null, null);
  }

  /** Closes as a real logical stream does: the caller's close is reported at once. */
  override close(): void {
    if (this.closed) return;
    super.close();
    this.closeHandler?.("closed", { kind: "caller" }, null, null);
  }
}

const fatal = (code: string): StreamCloseReason => ({
  kind: "fatalError",
  details: {
    code,
    reason: code,
    incompatibleMethods: null,
    upgradeGuidance: null,
  },
});

/** A session whose fatal close is already terminal when the listener attaches. */
class ClosedOnAttachSession extends ArmSession {
  override onStatusChange(handler: StatusChangeHandler): void {
    super.onStatusChange(handler);
    this.closeWith(fatal("FORBIDDEN"));
  }
}

const frameEnvelope = (
  generation: number,
  value: string,
): StreamFrameEnvelope => ({
  kind: "frame",
  hasBinaryPayload: false,
  generation,
  value,
});

describe("createEnvironmentArmLanes", () => {
  const sessions: ArmSession[] = [];
  const readStates: State[] = [];
  let lanes = createEnvironmentArmLanes<State, Frame>();

  function spec(key: string): EnvironmentArmLaneSpec<State, Frame> {
    return {
      key,
      poolHostId: "pool-host",
      client: new FakeStreamClient(true),
      initial: [],
      ended: ["ended"],
      open: (_client, readState) => {
        readStates.push(readState());
        const session = new ArmSession();
        sessions.push(session);
        session.emitStatus("open");
        return session;
      },
      parse: (envelope): EnvironmentArmFrame<Frame> | null => {
        if (envelope.kind === "pong") return { kind: "pong" };
        if (
          envelope.kind === "frame" &&
          typeof envelope.generation === "number" &&
          typeof envelope.value === "string"
        ) {
          return {
            kind: "frame",
            generation: envelope.generation,
            frame: { value: envelope.value },
          };
        }
        return null;
      },
      reduce: (state, frame) => [...state, frame.value],
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    lanes = createEnvironmentArmLanes<State, Frame>();
  });

  afterEach(() => {
    vi.useRealTimers();
    sessions.length = 0;
    readStates.length = 0;
    resetHostConnectionRegistryForTest();
  });

  it("opens one session for two holders of a key and closes it on the last release", () => {
    const releaseA = lanes.acquire(spec("k"));
    const releaseB = lanes.acquire(spec("k"));
    expect(sessions).toHaveLength(1);

    releaseA();
    expect(sessions[0]?.closed).toBe(false);
    releaseB();
    expect(sessions[0]?.closed).toBe(true);
    expect(lanes.read("k", [])).toEqual([]);
  });

  it("applies frames in order and discards one built under an older generation", () => {
    lanes.acquire(spec("k"));
    const session = sessions[0];

    session.emit(frameEnvelope(2, "a"), null);
    session.emit(frameEnvelope(1, "stale"), null);
    session.emit(frameEnvelope(2, "b"), null);
    session.emit({ kind: "pong", hasBinaryPayload: false }, null);

    expect(lanes.read("k", [])).toEqual(["a", "b"]);
  });

  it("applies generation 0 again after the same session redials", () => {
    lanes.acquire(spec("k"));
    const session = sessions[0];
    session.emit(frameEnvelope(2, "a"), null);

    session.emitStatus("reconnecting");
    session.emitStatus("open");
    session.emit(frameEnvelope(0, "b"), null);

    expect(lanes.read("k", [])).toEqual(["a", "b"]);
  });

  it("keeps discarding an older generation after a held drop and a continued open", () => {
    lanes.acquire(spec("k"));
    const session = sessions[0];
    session.emit(frameEnvelope(2, "a"), null);

    session.emitContinuityStatus("reconnecting", "held");
    session.emitContinuityStatus("open", "continued");
    session.emit(frameEnvelope(0, "stale"), null);
    session.emit(frameEnvelope(2, "b"), null);

    expect(lanes.read("k", [])).toEqual(["a", "b"]);
  });

  it("applies generation 0 again once the hold ends and the stream reopens", () => {
    lanes.acquire(spec("k"));
    const session = sessions[0];
    session.emit(frameEnvelope(2, "a"), null);

    session.emitContinuityStatus("reconnecting", "held");
    session.emitContinuityStatus("reconnecting", null);
    session.emitContinuityStatus("open", null);
    session.emit(frameEnvelope(0, "b"), null);

    expect(lanes.read("k", [])).toEqual(["a", "b"]);
  });

  it("applies generation 0 again on a reopened session", async () => {
    lanes.acquire(spec("k"));
    sessions[0]?.emit(frameEnvelope(2, "a"), null);

    sessions[0]?.closeWith(fatal("UNAUTHORIZED"));
    await vi.advanceTimersByTimeAsync(600_000);
    sessions[1]?.emit(frameEnvelope(0, "b"), null);

    expect(sessions).toHaveLength(2);
    expect(lanes.read("k", [])).toEqual(["a", "b"]);
  });

  it("asks the session to reconnect on an unparseable frame and on a binary payload", () => {
    lanes.acquire(spec("k"));
    const session = sessions[0];

    session.emit({ kind: "unknown", hasBinaryPayload: false }, null);
    expect(session.reconnects).toBe(1);

    session.emit(
      { ...frameEnvelope(1, "x"), hasBinaryPayload: true },
      new Uint8Array([1]),
    );
    expect(session.reconnects).toBe(2);
    expect(lanes.read("k", [])).toEqual([]);
  });

  it.each(["FORBIDDEN", "TEAM_MEMBER_REMOVED"])(
    "ends the arm on a %s close and does not reopen",
    async (code) => {
      lanes.acquire(spec("k"));
      sessions[0]?.emit(frameEnvelope(1, "a"), null);

      sessions[0]?.closeWith(fatal(code));
      await vi.advanceTimersByTimeAsync(600_000);

      expect(lanes.read("k", [])).toEqual(["ended"]);
      expect(sessions).toHaveLength(1);
    },
  );

  it("reopens an ended arm when asked", () => {
    lanes.acquire(spec("k"));
    sessions[0]?.closeWith(fatal("FORBIDDEN"));
    lanes.reopen("k");
    sessions[1]?.emit(frameEnvelope(0, "a"), null);

    expect(sessions).toHaveLength(2);
    expect(lanes.read("k", [])).toEqual(["ended", "a"]);
  });

  it("keeps the replacement open when a reopen scheduled for the stream it replaced comes due", async () => {
    lanes.acquire(spec("k"));
    sessions[0]?.closeWith(fatal("UNAUTHORIZED"));
    lanes.reopen("k");
    await vi.advanceTimersByTimeAsync(600_000);

    expect(sessions).toHaveLength(2);
    expect(sessions[1]?.closed).toBe(false);
  });

  it("replaces a live arm's stream when asked, so a refusal the old stream still carried does not end it", () => {
    lanes.acquire(spec("k"));
    lanes.reopen("k");
    sessions[0]?.closeWith(fatal("FORBIDDEN"));
    sessions[1]?.emit(frameEnvelope(0, "a"), null);

    expect(sessions).toHaveLength(2);
    expect(lanes.read("k", [])).toEqual(["a"]);
  });

  it("reopens after a retryable fatal close, resuming from the applied state", async () => {
    lanes.acquire(spec("k"));
    sessions[0]?.emit(frameEnvelope(1, "a"), null);

    sessions[0]?.closeWith(fatal("UNAUTHORIZED"));
    await vi.advanceTimersByTimeAsync(600_000);

    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.closed).toBe(true);
    expect(readStates).toEqual([[], ["a"]]);
    sessions[1]?.emit(frameEnvelope(1, "b"), null);
    expect(lanes.read("k", [])).toEqual(["a", "b"]);
  });

  it("lets a reader subscribe before the lane exists and hear its first frame", () => {
    const heard = vi.fn();
    const unsubscribe = lanes.subscribe("k", heard);

    lanes.acquire(spec("k"));
    expect(heard).not.toHaveBeenCalled();
    sessions[0]?.emit(frameEnvelope(1, "a"), null);
    expect(heard).toHaveBeenCalledTimes(1);

    unsubscribe();
    sessions[0]?.emit(frameEnvelope(1, "b"), null);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("lets a passive reader of held() subscribe before any lane exists and hear each change", () => {
    const seen: Array<ReadonlyArray<readonly [string, State]>> = [];
    const unsubscribe = lanes.subscribeHeld(() => {
      seen.push(lanes.held());
    });

    const release = lanes.acquire(spec("k"));
    expect(seen).toEqual([]);
    sessions[0]?.emit(frameEnvelope(1, "a"), null);
    expect(seen).toEqual([[["k", ["a"]]]]);

    release();
    expect(seen).toEqual([[["k", ["a"]]], []]);

    unsubscribe();
    lanes.acquire(spec("k"));
    sessions[1]?.emit(frameEnvelope(1, "b"), null);
    expect(seen).toEqual([[["k", ["a"]]], []]);
    expect(lanes.held()).toEqual([["k", ["b"]]]);
  });

  it("shows an arm that ended while it opened in held() at the last notification", () => {
    const seen: Array<ReadonlyArray<readonly [string, State]>> = [];
    lanes.subscribeHeld(() => {
      seen.push(lanes.held());
    });

    lanes.acquire({
      ...spec("k"),
      open: () => {
        const session = new ClosedOnAttachSession();
        sessions.push(session);
        return session;
      },
    });

    expect(seen.at(-1)).toEqual([["k", ["ended"]]]);
    expect(lanes.read("k", [])).toEqual(["ended"]);
  });

  it("lists only the lanes someone holds", () => {
    const releaseA = lanes.acquire(spec("a"));
    lanes.acquire(spec("b"));
    sessions[0]?.emit(frameEnvelope(1, "x"), null);
    expect(lanes.held()).toEqual([
      ["a", ["x"]],
      ["b", []],
    ]);

    releaseA();
    expect(lanes.held()).toEqual([["b", []]]);
  });
});
