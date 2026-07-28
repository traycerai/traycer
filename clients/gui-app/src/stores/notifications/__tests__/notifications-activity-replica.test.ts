/**
 * Lifecycle of the agent-activity awareness replica the per-user notification
 * room feeds. Covers the two resets that keep it honest - identity teardown and
 * a per-stream room reopen - plus the `@1.0` host case, where no `awareness`
 * frame ever arrives.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import type { NotificationsStreamCallbacks } from "@traycer-clients/shared/host-transport/notifications-stream-client";
import { AGENT_ACTIVITY_AWARENESS_FIELD } from "@/lib/notifications/agent-activity-presence";
import {
  __applyNotificationsAwarenessForTests,
  __resetNotificationsStoreForTests,
  openNotificationsStream,
  useNotificationsStore,
} from "@/stores/notifications/notifications-store";

/**
 * How many `destroy` listeners are registered on a Y.Doc. `Y.Doc` extends
 * lib0's `ObservableV2`, whose `_observers` map is part of its published type,
 * so this needs no cast - and it is the only observable that distinguishes
 * "the retired reader was fully torn down" from "its closure is still held".
 */
function destroyListenerCount(target: Y.Doc): number {
  return target._observers.get("destroy")?.size ?? 0;
}

const EPIC_ID = "epic-1";

interface OpenedStream {
  readonly callbacks: NotificationsStreamCallbacks;
  readonly dispose: () => void;
}

function openStream(): OpenedStream {
  const captured: { value: NotificationsStreamCallbacks | null } = {
    value: null,
  };
  const dispose = openNotificationsStream((callbacks) => {
    captured.value = callbacks;
    return {
      applyUpdate: () => undefined,
      close: () => undefined,
    };
  }, null);
  const callbacks = captured.value;
  if (callbacks === null) throw new Error("factory was never invoked");
  return { callbacks, dispose };
}

/**
 * A persistent publishing host. Holding the producer (and therefore its
 * clientId and awareness clock) across calls is what makes `replay()`
 * meaningful: it re-ships the CURRENT state at the CURRENT clock, exactly as
 * the host resolver's attach-time `emitExistingAwarenessStates` does. A test
 * that builds a fresh producer per encode gets a brand-new clientId every time
 * and can never catch a clock-rejection bug.
 */
interface HostPresenceProducer {
  publish(agentIds: readonly string[]): Uint8Array;
  replay(): Uint8Array;
  /** A clean room disconnect: a null state at a bumped clock. */
  disconnect(): Uint8Array;
  destroy(): void;
}

function createHostPresenceProducer(): HostPresenceProducer {
  const doc = new Y.Doc();
  const producer = new Awareness(doc);
  const encode = (): Uint8Array =>
    encodeAwarenessUpdate(producer, [producer.clientID]);
  return {
    publish: (agentIds) => {
      producer.setLocalState({
        [AGENT_ACTIVITY_AWARENESS_FIELD]: {
          [EPIC_ID]: { working: agentIds, turn: agentIds },
        },
      });
      return encode();
    },
    replay: encode,
    disconnect: () => {
      producer.setLocalState(null);
      return encode();
    },
    destroy: () => {
      producer.destroy();
      doc.destroy();
    },
  };
}

/**
 * One host's presence, encoded exactly as it arrives on the wire so the test
 * exercises the real y-protocols decode rather than a hand-built state map.
 * Each call is a DISTINCT host - use {@link createHostPresenceProducer} when
 * the test needs the same host across a transition.
 */
function encodeHostPresence(agentIds: readonly string[]): {
  readonly bytes: Uint8Array;
} {
  const doc = new Y.Doc();
  const producer = new Awareness(doc);
  producer.setLocalState({
    [AGENT_ACTIVITY_AWARENESS_FIELD]: {
      [EPIC_ID]: { working: agentIds, turn: agentIds },
    },
  });
  const bytes = encodeAwarenessUpdate(producer, [producer.clientID]);
  // One-shot: the bytes are captured, so the producer has no reason to outlive
  // this call holding its renewal interval open. `createHostPresenceProducer`
  // is the variant to reach for when a caller needs a persistent clientID.
  producer.destroy();
  doc.destroy();
  return { bytes };
}

function workingIds(): ReadonlySet<string> {
  return (
    useNotificationsStore.getState().agentActivityByEpic.get(EPIC_ID)
      ?.working ?? new Set<string>()
  );
}

afterEach(() => {
  __resetNotificationsStoreForTests();
});

describe("notification-room activity replica", () => {
  it("folds an inbound awareness frame into the cross-epic union", () => {
    const stream = openStream();
    const { bytes } = encodeHostPresence(["agent-a"]);

    stream.callbacks.onAwareness(bytes);

    expect([...workingIds()]).toEqual(["agent-a"]);
    stream.dispose();
  });

  it("reads idle against a host that never sends an awareness frame", () => {
    // A `@1.0` host: the transport downgrades the negotiated minor and the
    // frame simply never arrives. Every surface then reads idle from this
    // source and falls back to the local session state it already layers on.
    const stream = openStream();

    stream.callbacks.onSnapshot(
      { schemaVersion: "1.0.0" },
      Y.encodeStateAsUpdate(new Y.Doc()),
    );

    expect(useNotificationsStore.getState().agentActivityByEpic.size).toBe(0);
    stream.dispose();
  });

  it("clears the union on identity reset (sign-out / user switch)", () => {
    const stream = openStream();
    const { bytes } = encodeHostPresence(["agent-a"]);
    stream.callbacks.onAwareness(bytes);
    expect(workingIds().size).toBe(1);

    stream.dispose();
    useNotificationsStore.getState().reset();

    expect(useNotificationsStore.getState().agentActivityByEpic.size).toBe(0);
  });

  it("keeps applying frames after an identity reset swaps the replica", () => {
    const first = openStream();
    first.callbacks.onAwareness(encodeHostPresence(["agent-a"]).bytes);
    first.dispose();
    useNotificationsStore.getState().reset();

    const second = openStream();
    second.callbacks.onAwareness(encodeHostPresence(["agent-b"]).bytes);

    expect([...workingIds()]).toEqual(["agent-b"]);
    second.dispose();
  });

  it("drops carried-over presence when the room stream is reopened", () => {
    // A reopen only happens after the session has been dead for minutes, so
    // every entry still held is stale by construction; the attaching host
    // re-ships whatever is actually current.
    const first = openStream();
    first.callbacks.onAwareness(encodeHostPresence(["agent-a"]).bytes);
    expect(workingIds().size).toBe(1);
    first.dispose();

    const second = openStream();

    expect(useNotificationsStore.getState().agentActivityByEpic.size).toBe(0);

    second.callbacks.onAwareness(encodeHostPresence(["agent-c"]).bytes);
    expect([...workingIds()]).toEqual(["agent-c"]);
    second.dispose();
  });

  it("accepts the same host's attach-time replay after a reopen", () => {
    // Regression: resetting with `removeAwarenessStates` dropped the entries
    // but kept each remote clientId's `meta.clock`. The reopened session's
    // replay re-ships the SAME state at the SAME clock, which
    // `applyAwarenessUpdate` then rejected (`currClock === clock`) - so the
    // agent stayed invisible until the publisher's next renewal ~15s later.
    // The host is unchanged across the reopen here, which is the only way to
    // see it.
    const host = createHostPresenceProducer();
    const first = openStream();
    first.callbacks.onAwareness(host.publish(["agent-a"]));
    expect([...workingIds()]).toEqual(["agent-a"]);
    first.dispose();

    const second = openStream();
    expect(useNotificationsStore.getState().agentActivityByEpic.size).toBe(0);

    second.callbacks.onAwareness(host.replay());

    expect([...workingIds()]).toEqual(["agent-a"]);
    second.dispose();
    host.destroy();
  });

  it("accepts the same host's replay after an identity reset", () => {
    // `replace()` swaps the instance outright, so it never had the clock bug -
    // but the two resets must not be allowed to drift apart.
    //
    // The replay goes in through the apply seam DIRECTLY, with no intervening
    // `openStream()`: reopening would run `clearAwareness` and reset the clocks
    // a second time, so a `replace()` that started retaining them would still
    // pass. This asserts `replace()` on its own.
    const host = createHostPresenceProducer();
    const first = openStream();
    first.callbacks.onAwareness(host.publish(["agent-a"]));
    first.dispose();
    useNotificationsStore.getState().reset();
    expect(useNotificationsStore.getState().agentActivityByEpic.size).toBe(0);

    __applyNotificationsAwarenessForTests(host.replay());

    expect([...workingIds()]).toEqual(["agent-a"]);
    host.destroy();
  });

  it("does not accumulate listeners on the notifications doc across reopens", () => {
    // `Awareness` registers an anonymous `doc.on("destroy")` its own `destroy()`
    // never unregisters. The notifications doc outlives every reader swap, so a
    // reader bound to it would leave one dead closure per reopen behind, each
    // retaining a retired instance's states and meta.
    const notificationsDoc = useNotificationsStore.getState().doc;

    // Positive control. `_observers` is a lib0 `ObservableV2` implementation
    // detail: if a yjs/lib0 update stopped tracking `destroy` there, every
    // count below would read 0 and the leak assertion would pass vacuously.
    // Proving the probe SEES a listener it just registered makes that failure
    // mode loud instead of silent. There is no public API that distinguishes a
    // fully retired reader from one whose closure is still held, so the
    // internal read stays - guarded rather than trusted.
    const probeDoc = new Y.Doc();
    const probeBaseline = destroyListenerCount(probeDoc);
    const probeAwareness = new Awareness(probeDoc);
    expect(destroyListenerCount(probeDoc)).toBe(probeBaseline + 1);
    probeAwareness.destroy();
    probeDoc.destroy();

    const before = destroyListenerCount(notificationsDoc);

    for (let i = 0; i < 4; i += 1) {
      const stream = openStream();
      stream.callbacks.onAwareness(encodeHostPresence([`agent-${i}`]).bytes);
      stream.dispose();
    }

    expect(destroyListenerCount(notificationsDoc)).toBe(before);
  });

  it("clears a host that disconnects cleanly", () => {
    // The primary self-clearing path: a host leaving the room removes its own
    // awareness entry, which arrives as a null state at a bumped clock. No
    // cleanup protocol on either side.
    //
    // The BACKSTOP - y-protocols' ~30s sweep of entries that stopped renewing,
    // for a host that dies without a clean disconnect - is deliberately not
    // covered here: `lib0/time` binds `getUnixTime = Date.now` by reference at
    // module load, and y-protocols is an externalized dependency, so neither
    // `vi.useFakeTimers()` nor a module mock can move the clock it reads. What
    // this replica owns for that path is the reader-only local state that keeps
    // the sweep's eviction arm live; the sweep itself is upstream behaviour and
    // needs the dev-app check.
    const host = createHostPresenceProducer();
    const stream = openStream();
    stream.callbacks.onAwareness(host.publish(["agent-a"]));
    expect(workingIds().size).toBe(1);

    stream.callbacks.onAwareness(host.disconnect());

    expect(useNotificationsStore.getState().agentActivityByEpic.size).toBe(0);
    stream.dispose();
    host.destroy();
  });
});
