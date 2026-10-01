import { describe, expect, it } from "vitest";
import type {
  ChatPortForward,
  PortForwardEvent,
} from "@traycer/protocol/host/port-forward";
import {
  keyedPortForwardEventsNewestFirst,
  portForwardEventLabel,
  portForwardListenPort,
} from "@/lib/port-forward/port-forward-display";

function chatPortForward(over: Partial<ChatPortForward>): ChatPortForward {
  return {
    forwardId: "forward-1",
    description: "dev server",
    target: { hostId: "host-target", port: 3000 },
    listen: { hostId: "host-listen", requestedPort: 8080, boundPort: null },
    state: "active",
    stateReason: null,
    createdAtMs: 1,
    recentEvents: [],
    ...over,
  };
}

function event(over: Partial<PortForwardEvent>): PortForwardEvent {
  return {
    atMs: 1,
    kind: "port-taken",
    detail: null,
    ...over,
  };
}

describe("portForwardListenPort", () => {
  it("prefers the bound port once one exists", () => {
    const forward = chatPortForward({
      listen: { hostId: "host-listen", requestedPort: 8080, boundPort: 8081 },
    });
    expect(portForwardListenPort(forward)).toBe(8081);
  });

  it("falls back to the requested port when nothing is bound yet", () => {
    const forward = chatPortForward({
      listen: { hostId: "host-listen", requestedPort: 8080, boundPort: null },
    });
    expect(portForwardListenPort(forward)).toBe(8080);
  });
});

describe("portForwardEventLabel", () => {
  it("labels port-taken", () => {
    expect(portForwardEventLabel("port-taken")).toBe("Port taken");
  });

  it("labels target-refused", () => {
    expect(portForwardEventLabel("target-refused")).toBe("Nothing listening");
  });

  it("labels lease-reaped", () => {
    expect(portForwardEventLabel("lease-reaped")).toBe("Lease ended");
  });

  it("labels link-dropped", () => {
    expect(portForwardEventLabel("link-dropped")).toBe("Link dropped");
  });

  it("labels cut-by-user", () => {
    expect(portForwardEventLabel("cut-by-user")).toBe("Cut");
  });
});

describe("keyedPortForwardEventsNewestFirst", () => {
  it("returns an empty array for empty input", () => {
    expect(keyedPortForwardEventsNewestFirst([])).toEqual([]);
  });

  it("orders the keyed events newest first", () => {
    const oldest = event({ atMs: 1, kind: "port-taken" });
    const middle = event({ atMs: 2, kind: "target-refused" });
    const newest = event({ atMs: 3, kind: "cut-by-user" });

    const keyed = keyedPortForwardEventsNewestFirst([oldest, middle, newest]);

    expect(keyed.map((k) => k.event)).toEqual([newest, middle, oldest]);
  });

  it("gives two events sharing (atMs, kind) different keys", () => {
    const first = event({ atMs: 5, kind: "port-taken", detail: "first" });
    const second = event({ atMs: 5, kind: "port-taken", detail: "second" });

    const keyed = keyedPortForwardEventsNewestFirst([first, second]);

    expect(keyed).toHaveLength(2);
    const keys = keyed.map((k) => k.key);
    expect(new Set(keys).size).toBe(2);
  });

  // The property the function exists for: an occurrence count assigned
  // OLDEST-first must not be renamed by a later arrival at the head. A key
  // scheme that instead counted from the newest end would flip every
  // existing key on the screen the moment a new sharing event arrived,
  // remounting every row in that group for no visible reason.
  it("leaves earlier events' keys unchanged when a newer event is appended", () => {
    const first = event({ atMs: 5, kind: "port-taken", detail: "first" });
    const second = event({ atMs: 5, kind: "port-taken", detail: "second" });

    const before = keyedPortForwardEventsNewestFirst([first, second]);
    const keyByEvent = new Map(before.map((k) => [k.event, k.key]));

    const third = event({ atMs: 5, kind: "port-taken", detail: "third" });
    const after = keyedPortForwardEventsNewestFirst([first, second, third]);

    expect(keyByEvent.get(first)).toBe(
      after.find((k) => k.event === first)?.key,
    );
    expect(keyByEvent.get(second)).toBe(
      after.find((k) => k.event === second)?.key,
    );
    // Falsification: swapping the occurrence count to count from the newest
    // end (or reversing before assigning) would change `first`'s or
    // `second`'s key here even though neither event moved in the input.
    const afterKeys = after.map((k) => k.key);
    expect(new Set(afterKeys).size).toBe(3);
  });
});
