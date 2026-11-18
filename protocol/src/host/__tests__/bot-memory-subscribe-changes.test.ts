import { describe, expect, it } from "vitest";
import {
  buildStreamManifest,
  checkStreamMethodCompatibility,
} from "@traycer/protocol/framework/stream-compat";
import { SERVES_EVERY_INSTALLED_MAJOR } from "@traycer/protocol/framework/capability-manifest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import {
  botMemorySubscribeV10,
  botMemorySubscribeV11,
} from "@traycer/protocol/host/bot/contracts";

const METHOD = "bot.memory.subscribe";

const USAGE = { entries: 0, chars: 0, ceiling: 4000 } as const;
const CHANGE = {
  id: "change-1",
  at: 1_753_000_000_000,
  action: "add",
  memory: "shared",
  entryId: "entry-1",
  threadId: "thread-1",
} as const;
const MEMORY_V10 = { entries: [], own: USAGE, shared: USAGE } as const;

function snapshot(memory: unknown) {
  return { kind: "snapshot", memory, hasBinaryPayload: false };
}

describe("bot.memory.subscribe@1.1 contract", () => {
  const line = hostStreamRpcRegistry[METHOD][1];

  it("declares 1.1 as the latest minor, binding V10 at 0 and V11 at 1", () => {
    expect(botMemorySubscribeV11.schemaVersion).toEqual({ major: 1, minor: 1 });
    expect(line.latestMinor).toBe(1);
    expect(line.versions[0].contract).toBe(botMemorySubscribeV10);
    expect(line.versions[1].contract).toBe(botMemorySubscribeV11);
    expect(
      buildStreamManifest(hostStreamRpcRegistry, SERVES_EVERY_INSTALLED_MAJOR)[
        METHOD
      ],
    ).toEqual({ major: 1, minor: 1 });
  });

  it("is compatible with itself on the stream handshake", () => {
    const manifest = buildStreamManifest(
      hostStreamRpcRegistry,
      SERVES_EVERY_INSTALLED_MAJOR,
    );

    expect(
      checkStreamMethodCompatibility(
        hostStreamRpcRegistry,
        manifest,
        manifest,
        "host",
        METHOD,
      ).ok,
    ).toBe(true);
  });

  it("strips the changes from a 1.1 snapshot at the frozen 1.0 frame", () => {
    const frame = snapshot({ ...MEMORY_V10, changes: [CHANGE] });

    expect(botMemorySubscribeV10.serverFrameSchema.parse(frame)).toEqual(
      snapshot(MEMORY_V10),
    );
  });

  it("keeps the changes at the 1.1 frame and rejects a memory without them", () => {
    const frame = snapshot({ ...MEMORY_V10, changes: [CHANGE] });

    expect(botMemorySubscribeV11.serverFrameSchema.parse(frame)).toEqual(frame);
    expect(
      botMemorySubscribeV11.serverFrameSchema.safeParse(snapshot(MEMORY_V10))
        .success,
    ).toBe(false);
  });

  it("accepts a change made on the channel, whose thread is null", () => {
    const frame = snapshot({
      ...MEMORY_V10,
      changes: [{ ...CHANGE, threadId: null }],
    });

    expect(botMemorySubscribeV11.serverFrameSchema.parse(frame)).toEqual(frame);
  });

  it.each([
    ["action", { action: "rename" }],
    ["memory", { memory: "private" }],
    ["entry id", { entryId: "" }],
    ["thread id", { threadId: "" }],
  ])("rejects a change with an unknown or empty %s", (_name, override) => {
    const frame = snapshot({
      ...MEMORY_V10,
      changes: [{ ...CHANGE, ...override }],
    });

    expect(
      botMemorySubscribeV11.serverFrameSchema.safeParse(frame).success,
    ).toBe(false);
  });

  it("keeps the pong frame on both versions", () => {
    const pong = { kind: "pong", hasBinaryPayload: false };

    expect(botMemorySubscribeV10.serverFrameSchema.parse(pong)).toEqual(pong);
    expect(botMemorySubscribeV11.serverFrameSchema.parse(pong)).toEqual(pong);
  });
});
