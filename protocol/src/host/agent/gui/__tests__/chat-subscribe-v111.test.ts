import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  chatSubscribeV110,
  chatSubscribeV111,
} from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * `chat.subscribe@1.11` is registered purely as a capability signal: images
 * by reference on the send frame. NO frame shape changes - all three schemas
 * are `@1.10`'s, by reference, which is the thing that lets a `@1.11` host and
 * a `@1.10` host exchange identical frames while only the negotiated minor
 * differs.
 */
describe("chat.subscribe@1.11", () => {
  it("is registered at versions[11]", () => {
    const line = hostStreamRpcRegistry["chat.subscribe"][1];
    expect(line.versions[11].contract).toBe(chatSubscribeV111);
  });

  it("declares schemaVersion {1, 11}", () => {
    expect(chatSubscribeV111.schemaVersion).toEqual({ major: 1, minor: 11 });
  });

  it("binds the SAME three schema instances as chatSubscribeV110 - no frame-shape change", () => {
    expect(chatSubscribeV111.openRequestSchema).toBe(
      chatSubscribeV110.openRequestSchema,
    );
    expect(chatSubscribeV111.serverFrameSchema).toBe(
      chatSubscribeV110.serverFrameSchema,
    );
    expect(chatSubscribeV111.clientFrameSchema).toBe(
      chatSubscribeV110.clientFrameSchema,
    );
  });
});
