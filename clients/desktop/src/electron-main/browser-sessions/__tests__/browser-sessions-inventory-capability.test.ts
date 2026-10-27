import { describe, expect, it, vi } from "vitest";
import { BrowserSessionsRegistry } from "../browser-sessions-owner";
import {
  createRegistryHarness,
  type FakeStreamSession,
  type RegistryHarness,
} from "./browser-sessions-stream-fixture";

vi.mock("../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  describeLogError: (error: unknown) => String(error),
}));

async function openStream(
  harness: RegistryHarness,
  registry: BrowserSessionsRegistry,
  minor: number,
): Promise<FakeStreamSession> {
  registry.open("window-1", {
    scope: { kind: "epic", epicId: "epic-1" },
    hostId: "host-1",
    identityKey: "identity-1",
  });
  await vi.waitFor(() => {
    expect(harness.clients.at(-1)?.sessions[0]).toBeDefined();
  });
  const session = harness.clients.at(-1)?.sessions[0];
  if (session === undefined) throw new Error("no stream was subscribed");
  session.negotiatedSchemaVersion = { major: 2, minor };
  session.emitStatus("open");
  return session;
}

function eventKinds(harness: RegistryHarness): readonly string[] {
  return harness.emitted.flatMap((entry) => {
    const event = entry.envelope.event;
    if (event.kind === "inventoryCapability")
      return [`capability:${String(event.supported)}`];
    if (event.kind === "frame") return [`frame:${event.frame.kind}`];
    return [];
  });
}

describe("desktop browser sessions inventory capability", () => {
  it("tells the renderer a 2.3 stream supports inventory revisions before its first frame, once", async () => {
    const harness = createRegistryHarness();
    const registry = new BrowserSessionsRegistry(harness.deps);
    const session = await openStream(harness, registry, 3);

    session.emit(
      { kind: "snapshot", hasBinaryPayload: false, sessions: [] },
      null,
    );
    session.emit(
      { kind: "snapshot", hasBinaryPayload: false, sessions: [] },
      null,
    );

    const kinds = eventKinds(harness);
    expect(kinds.filter((kind) => kind.startsWith("capability:"))).toEqual([
      "capability:true",
    ]);
    expect(kinds.indexOf("capability:true")).toBeLessThan(
      kinds.indexOf("frame:snapshot"),
    );
  });

  it("tells the renderer an older negotiated line does not support inventory revisions", async () => {
    const harness = createRegistryHarness();
    const registry = new BrowserSessionsRegistry(harness.deps);
    const session = await openStream(harness, registry, 2);

    session.emit(
      { kind: "snapshot", hasBinaryPayload: false, sessions: [] },
      null,
    );

    const kinds = eventKinds(harness);
    expect(kinds).toContain("capability:false");
    expect(kinds).not.toContain("capability:true");
    expect(kinds.indexOf("capability:false")).toBeLessThan(
      kinds.indexOf("frame:snapshot"),
    );
  });
});

const KEY = {
  scope: { kind: "epic", epicId: "epic-1" } as const,
  hostId: "host-1",
  identityKey: "identity-1",
};

/** One ordered log across what the renderer is told and what main asks the host. */
function orderedRegistry(
  harness: RegistryHarness,
  log: string[],
): BrowserSessionsRegistry {
  return new BrowserSessionsRegistry({
    ...harness.deps,
    emit: (windowId, envelope) => {
      harness.deps.emit(windowId, envelope);
      const event = envelope.event;
      if (event.kind === "inventoryCapability")
        log.push(`capability:${String(event.supported)}`);
    },
  });
}

async function openHeldStream(
  harness: RegistryHarness,
  log: string[],
): Promise<FakeStreamSession> {
  await vi.waitFor(() => {
    expect(harness.clients.at(-1)?.sessions[0]).toBeDefined();
  });
  const session = harness.clients.at(-1)?.sessions[0];
  if (session === undefined) throw new Error("no stream was subscribed");
  session.negotiatedSchemaVersion = { major: 2, minor: 3 };
  session.emitStatus("open");
  session.emit(
    { kind: "snapshot", hasBinaryPayload: false, sessions: [] },
    null,
  );
  const send = session.sendClientFrame.bind(session);
  vi.spyOn(session, "sendClientFrame").mockImplementation((frame, payload) => {
    log.push(`client:${frame.kind}`);
    send(frame, payload);
  });
  return session;
}

describe("desktop browser sessions inventory capability on renderer reattach", () => {
  it("replays the current capability to a renderer that returns while preparation holds the stream, before it asks for a fresh snapshot", async () => {
    const harness = createRegistryHarness();
    const log: string[] = [];
    const registry = orderedRegistry(harness, log);
    registry.open("window-1", KEY);
    const releasePreparation = registry.acquirePreparation(
      "window-1",
      KEY,
      () => undefined,
    );
    const session = await openHeldStream(harness, log);

    registry.close("window-1", KEY);
    expect(session.closed).toBe(false);
    log.length = 0;
    registry.open("window-1", KEY);

    expect(log.indexOf("capability:true")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("capability:true")).toBeLessThan(
      log.indexOf("client:requestSnapshot"),
    );
    releasePreparation?.();
  });

  it("gives a renderer that attaches to a preparation-first stream the capability before its snapshot request", async () => {
    const harness = createRegistryHarness();
    const log: string[] = [];
    const registry = orderedRegistry(harness, log);
    const releasePreparation = registry.acquirePreparation(
      "window-1",
      KEY,
      () => undefined,
    );
    const session = await openHeldStream(harness, log);
    // The stream reached 2.3 with nobody rendering; nothing a renderer needs has been replayed yet.
    log.length = 0;

    registry.open("window-1", KEY);

    expect(log.indexOf("capability:true")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("capability:true")).toBeLessThan(
      log.indexOf("client:requestSnapshot"),
    );
    expect(session.closed).toBe(false);
    releasePreparation?.();
  });

  it("forgets the capability when the connection drops, so a returning renderer is not told stale support", async () => {
    const harness = createRegistryHarness();
    const log: string[] = [];
    const registry = orderedRegistry(harness, log);
    registry.open("window-1", KEY);
    const releasePreparation = registry.acquirePreparation(
      "window-1",
      KEY,
      () => undefined,
    );
    const session = await openHeldStream(harness, log);

    registry.close("window-1", KEY);
    session.emitStatus("reconnecting");
    log.length = 0;
    registry.open("window-1", KEY);

    expect(log).not.toContain("capability:true");
    releasePreparation?.();
  });
});
