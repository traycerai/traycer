import { describe, expect, it } from "vitest";
import { isValidLocalHostWebsocketUrl } from "../pid-metadata";

describe("host pid metadata endpoint validation", () => {
  it("accepts local host websocket endpoints", () => {
    expect(isValidLocalHostWebsocketUrl("ws://127.0.0.1:7100/rpc")).toBe(true);
    expect(isValidLocalHostWebsocketUrl("wss://127.0.0.1:7100/rpc")).toBe(true);
  });

  it("rejects non-local or malformed websocket endpoints", () => {
    expect(isValidLocalHostWebsocketUrl("http://127.0.0.1:7100/rpc")).toBe(
      false,
    );
    expect(isValidLocalHostWebsocketUrl("ws://localhost:7100/rpc")).toBe(false);
    expect(isValidLocalHostWebsocketUrl("ws://127.0.0.1/rpc")).toBe(false);
    expect(isValidLocalHostWebsocketUrl("ws://127.0.0.1:7100/stream")).toBe(
      false,
    );
    expect(isValidLocalHostWebsocketUrl("ws://127.0.0.1:7100/rpc?x=1")).toBe(
      false,
    );
    expect(isValidLocalHostWebsocketUrl("ws://attacker.example:7100/rpc")).toBe(
      false,
    );
    expect(
      isValidLocalHostWebsocketUrl("ws://127.0.0.1.evil.example:7100/rpc"),
    ).toBe(false);
    expect(isValidLocalHostWebsocketUrl("not-a-url")).toBe(false);
  });
});
