import { afterEach, describe, expect, it } from "vitest";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import {
  appHostDoorObserver,
  appStreamDoorObserver,
  noteHostTokenRefusal,
} from "@/lib/host/host-door-observer";
import {
  clearHostDoorState,
  hostDoorStateFor,
} from "@/stores/host/host-door-state-store";

const releasedRefusal: FatalErrorDetails = {
  code: "UNAUTHORIZED",
  reason: "released-host-token-refusal",
  incompatibleMethods: null,
  upgradeGuidance: null,
};

const hostIds = new Set<string>();

function freshHost(name: string): string {
  const hostId = `door-observer-${name}`;
  hostIds.add(hostId);
  clearHostDoorState(hostId);
  return hostId;
}

afterEach(() => {
  for (const hostId of hostIds) clearHostDoorState(hostId);
  hostIds.clear();
});

describe("the app's door while the host has an admitted connection", () => {
  it("raises no mint state while a connection is admitted, and raises it once that connection is released", () => {
    const hostId = freshHost("mint");
    const release = appHostDoorObserver(hostId).admitted();

    noteHostTokenRefusal(hostId, "token-unavailable");
    expect(hostDoorStateFor(hostId)).toBeNull();

    release();
    noteHostTokenRefusal(hostId, "token-unavailable");
    expect(hostDoorStateFor(hostId)?.kind).toBe("token-unavailable");
  });

  it("raises no refusal state while a connection is admitted, and raises it once that connection is released", () => {
    const hostId = freshHost("refusal");
    const door = appHostDoorObserver(hostId);
    const release = door.admitted();

    door.refused(releasedRefusal);
    expect(hostDoorStateFor(hostId)).toBeNull();

    release();
    door.refused(releasedRefusal);
    expect(hostDoorStateFor(hostId)?.kind).toBe("older-host");
  });

  it("counts a stream's admission and a unary call's together, per host", () => {
    const hostId = freshHost("shared-count");
    const other = freshHost("other-host");
    const releaseStream = appStreamDoorObserver.admitted(hostId);
    const releaseCall = appHostDoorObserver(hostId).admitted();

    releaseStream();
    noteHostTokenRefusal(hostId, "token-unavailable");
    expect(hostDoorStateFor(hostId)).toBeNull();

    // Another host is not covered by this host's connections.
    noteHostTokenRefusal(other, "token-unavailable");
    expect(hostDoorStateFor(other)?.kind).toBe("token-unavailable");

    releaseCall();
    noteHostTokenRefusal(hostId, "token-unavailable");
    expect(hostDoorStateFor(hostId)?.kind).toBe("token-unavailable");
  });

  it("drops the refusal that ends one of two admitted connections while the other stays admitted, and raises a later one once the other is released", () => {
    const hostId = freshHost("two-connections");
    const door = appHostDoorObserver(hostId);
    const first = door.admitted();
    const second = door.admitted();

    // The ended connection is released before its own refusal is reported.
    second();
    door.refused(releasedRefusal);
    expect(hostDoorStateFor(hostId)).toBeNull();

    first();
    door.refused(releasedRefusal);
    expect(hostDoorStateFor(hostId)?.kind).toBe("older-host");
  });

  it("raises the refusal that ends the only admitted connection, once that connection is released", () => {
    const hostId = freshHost("only-connection");
    const door = appHostDoorObserver(hostId);
    const release = door.admitted();

    release();
    door.refused(releasedRefusal);
    expect(hostDoorStateFor(hostId)?.kind).toBe("older-host");
  });

  it("counts a release once, so a second call of it does not free another connection's admission", () => {
    const hostId = freshHost("release-once");
    const door = appHostDoorObserver(hostId);
    const first = door.admitted();
    door.admitted();

    first();
    first();
    noteHostTokenRefusal(hostId, "token-unavailable");
    expect(hostDoorStateFor(hostId)).toBeNull();
  });
});
