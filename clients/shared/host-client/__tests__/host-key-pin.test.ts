import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import {
  applyHostKeyPins,
  clearHostKeyPinStore,
  HostKeyPinMismatchError,
  installHostKeyPinStore,
  type HostKeyPinStore,
} from "../host-key-pin";
import { fetchRegisteredHostsViaHttp } from "../remote-fetcher";

const PIN_LOCATION = "/tmp/host-key-pins.json";

function item(hostId: string, publicKey: string): HostListItem {
  return {
    hostId,
    displayName: null,
    platform: "Ubuntu",
    kind: "personal",
    publicKey,
    createdAt: "2026-07-01T12:00:00.000Z",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.4.2",
      lastSeenAt: "2026-07-03T11:59:50.000Z",
    },
    updatePolicy: "manual",
  };
}

function memoryStore(seed: Record<string, string>): {
  readonly store: HostKeyPinStore;
  readonly pins: Record<string, string>;
} {
  const pins: Record<string, string> = { ...seed };
  return {
    pins,
    store: {
      read: (hostId) => Promise.resolve(pins[hostId] ?? null),
      pin: (hostId, publicKey) => {
        // First sight only, and answers with whoever holds the pin now - the
        // contract `applyHostKeyPins` refuses a race loser on.
        const incumbent = pins[hostId];
        if (incumbent !== undefined) return Promise.resolve(incumbent);
        pins[hostId] = publicKey;
        return Promise.resolve(publicKey);
      },
      describeLocation: () => PIN_LOCATION,
    },
  };
}

afterEach(() => {
  clearHostKeyPinStore();
  vi.unstubAllGlobals();
});

describe("host Noise static key TOFU pin", () => {
  it("pins on first sight and admits the host", async () => {
    const mismatches: HostKeyPinMismatchError[] = [];
    const { store, pins } = memoryStore({});
    installHostKeyPinStore({
      store,
      onMismatch: (error) => mismatches.push(error),
      onPinWriteFailed: () => undefined,
    });

    const admitted = await applyHostKeyPins([item("host-1", "pk-1")]);

    expect(admitted.map((host) => host.hostId)).toEqual(["host-1"]);
    expect(pins).toEqual({ "host-1": "pk-1" });
    expect(mismatches).toEqual([]);
  });

  it("admits the same key again without re-pinning", async () => {
    const { store } = memoryStore({ "host-1": "pk-1" });
    const pin = vi.fn(store.pin);
    installHostKeyPinStore({
      store: { ...store, pin },
      onMismatch: () => undefined,
      onPinWriteFailed: () => undefined,
    });

    const admitted = await applyHostKeyPins([item("host-1", "pk-1")]);

    expect(admitted).toHaveLength(1);
    expect(pin).not.toHaveBeenCalled();
  });

  it("refuses a changed key, names the host, and never silently re-pins", async () => {
    const mismatches: HostKeyPinMismatchError[] = [];
    const { store, pins } = memoryStore({ "host-1": "pk-1" });
    installHostKeyPinStore({
      store,
      onMismatch: (error) => mismatches.push(error),
      onPinWriteFailed: () => undefined,
    });

    const admitted = await applyHostKeyPins([
      item("host-1", "pk-IMPOSTER"),
      item("host-2", "pk-2"),
    ]);

    // The impostor is GONE from the list, so nothing downstream can dial it;
    // an unrelated host in the same answer is unaffected.
    expect(admitted.map((host) => host.hostId)).toEqual(["host-2"]);
    expect(pins["host-1"]).toBe("pk-1");
    expect(mismatches).toHaveLength(1);
    const refusal = mismatches[0];
    expect(refusal).toBeInstanceOf(HostKeyPinMismatchError);
    expect(refusal.hostId).toBe("host-1");
    expect(refusal.pinnedKey).toBe("pk-1");
    expect(refusal.offeredKey).toBe("pk-IMPOSTER");
    // The one honest recovery: there is no un-pin surface, so the message has
    // to say where the record lives.
    expect(refusal.message).toContain("host-1");
    expect(refusal.message).toContain(PIN_LOCATION);
  });

  it("is a pass-through for a shell with nowhere durable to pin", async () => {
    const admitted = await applyHostKeyPins([item("host-1", "pk-1")]);
    expect(admitted).toHaveLength(1);
  });

  it("R3-5: still admits a first-sight host when the store's write rejects, and reports the failure instead of a mismatch", async () => {
    // RULE: applyHostKeyPins must not let a pin WRITE failure fail the whole
    // registry read - the caller's contract is a `{ kind }` union, and a
    // read-only userData or ENOSPC must not refuse every host in the answer.
    // Nothing is pinned, so nothing disagrees: this is a write failure, not a
    // mismatch.
    const writeFailures: Array<{
      readonly hostId: string;
      readonly cause: unknown;
    }> = [];
    const mismatches: HostKeyPinMismatchError[] = [];
    const rejection = new Error("read-only userData");
    const store: HostKeyPinStore = {
      read: () => Promise.resolve(null),
      pin: () => Promise.reject(rejection),
      describeLocation: () => PIN_LOCATION,
    };
    installHostKeyPinStore({
      store,
      onMismatch: (error) => mismatches.push(error),
      onPinWriteFailed: (hostId, cause) =>
        writeFailures.push({ hostId, cause }),
    });

    const admitted = await applyHostKeyPins([item("host-1", "pk-1")]);

    expect(admitted.map((host) => host.hostId)).toEqual(["host-1"]);
    expect(writeFailures).toEqual([{ hostId: "host-1", cause: rejection }]);
    expect(mismatches).toEqual([]);
  });

  it("R3-10: one of two concurrent first-sight pins for the same host wins and the other is refused, not reported as a write failure", async () => {
    // RULE: first sight is atomic per host. Both calls read an unpinned host,
    // so the decision cannot live between `read` and `pin` - it has to be the
    // store's own read-and-first-write, and the loser is a MISMATCH (a key
    // disagrees with what is pinned) rather than a write failure (nothing is
    // pinned, so nothing disagrees, and the host is admitted).
    const mismatches: HostKeyPinMismatchError[] = [];
    const writeFailures: string[] = [];
    const { store, pins } = memoryStore({});
    installHostKeyPinStore({
      store,
      onMismatch: (error) => mismatches.push(error),
      onPinWriteFailed: (hostId) => writeFailures.push(hostId),
    });

    const [first, second] = await Promise.all([
      applyHostKeyPins([item("host-1", "pk-REAL")]),
      applyHostKeyPins([item("host-1", "pk-IMPOSTER")]),
    ]);

    const admitted = [...first, ...second];
    expect(admitted).toHaveLength(1);
    const winner = admitted[0];
    if (winner === undefined) throw new Error("expected one admitted host");
    expect(pins["host-1"]).toBe(winner.publicKey);
    expect(mismatches).toHaveLength(1);
    const refusal = mismatches[0];
    if (refusal === undefined) throw new Error("expected one refusal");
    expect(refusal.pinnedKey).toBe(winner.publicKey);
    expect(refusal.offeredKey).not.toBe(winner.publicKey);
    expect(writeFailures).toEqual([]);
  });

  it("drops a key-changed host from the registry read itself", async () => {
    const { store } = memoryStore({ "host-1": "pk-1" });
    installHostKeyPinStore({
      store,
      onMismatch: () => undefined,
      onPinWriteFailed: () => undefined,
    });
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ hosts: [item("host-1", "pk-ROTATED")] }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    const result = await fetchRegisteredHostsViaHttp(
      "https://authn.example.test",
      "bearer",
    );

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected an ok result");
    expect(result.response.hosts).toEqual([]);
  });
});
