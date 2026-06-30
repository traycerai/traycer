import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineRpcContract,
  defineVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import {
  MockHostMessenger,
  type MockPhaseEvent,
} from "../mock/mock-host-messenger";
import { HostRpcError } from "../../host-transport/host-messenger";

const echoV10 = defineRpcContract({
  method: "host.echo",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({ message: z.string() }),
  responseSchema: z.object({ echoed: z.string() }),
});

const registry = defineVersionedRpcRegistry({
  "host.echo": {
    1: {
      latestMinor: 0,
      versions: {
        0: { contract: echoV10, upgradeFromPreviousVersion: null },
      },
      downgradePathsFromLatest: {},
    },
  },
});

describe("MockHostMessenger", () => {
  it("returns canonical responses for registered handlers", async () => {
    const messenger = new MockHostMessenger<typeof registry>({
      registry,
      handlers: {
        "host.echo": ({ message }) => ({ echoed: message.toUpperCase() }),
      },
      requestId: () => "req-1",
    });

    const result = await messenger.request("host.echo", { message: "hi" });
    expect(result).toEqual({ echoed: "HI" });
    expect(messenger.calls).toEqual([
      { method: "host.echo", params: { message: "hi" }, requestId: "req-1" },
    ]);
  });

  it("surfaces missing handlers as HostRpcError", async () => {
    const messenger = new MockHostMessenger<typeof registry>({
      registry,
      handlers: {},
      requestId: () => "req-missing",
    });

    await expect(
      messenger.request("host.echo", { message: "x" }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof HostRpcError &&
        err.code === "RPC_ERROR" &&
        err.requestId === "req-missing",
    );
  });

  it("wraps handler throws as HostRpcError", async () => {
    const messenger = new MockHostMessenger<typeof registry>({
      registry,
      handlers: {
        "host.echo": () => {
          throw new Error("boom");
        },
      },
      requestId: () => "req-err",
    });

    await expect(
      messenger.request("host.echo", { message: "x" }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof HostRpcError && err.message === "boom",
    );
  });

  it("rewraps handler HostRpcError with the current request metadata", async () => {
    const fatalDetails = {
      code: "INCOMPATIBLE",
      reason: "host protocol mismatch",
      incompatibleMethods: [],
      upgradeGuidance: null,
    };
    const messenger = new MockHostMessenger<typeof registry>({
      registry,
      handlers: {
        "host.echo": () => {
          throw new HostRpcError({
            code: "INCOMPATIBLE",
            message: "handler supplied metadata",
            requestId: "handler-req",
            method: "handler.method",
            fatalDetails,
          });
        },
      },
      requestId: () => "req-current",
    });

    await expect(
      messenger.request("host.echo", { message: "x" }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof HostRpcError &&
        err.code === "INCOMPATIBLE" &&
        err.message === "handler supplied metadata" &&
        err.requestId === "req-current" &&
        err.method === "host.echo" &&
        err.fatalDetails === fatalDetails,
    );

    const responseEvent = messenger.phases[4];
    if (responseEvent.kind !== "response") {
      throw new Error("expected response phase at index 4");
    }
    expect(responseEvent.error?.requestId).toBe("req-current");
    expect(responseEvent.error?.method).toBe("host.echo");
  });

  it("emits phase hooks in the WS lifecycle order on the happy path", async () => {
    const messenger = new MockHostMessenger<typeof registry>({
      registry,
      handlers: {
        "host.echo": ({ message }) => ({ echoed: message.toUpperCase() }),
      },
      requestId: () => "req-phase",
    });

    const seen: MockPhaseEvent[] = [];
    const unsubscribe = messenger.subscribe((event) => {
      seen.push(event);
    });

    await messenger.request("host.echo", { message: "hi" });
    unsubscribe();

    const kinds = seen.map((event) => event.kind);
    expect(kinds).toEqual([
      "open",
      "auth",
      "manifest",
      "request",
      "response",
      "close",
    ]);
    expect(messenger.phases.map((event) => event.kind)).toEqual(kinds);

    const requestEvent = seen[3];
    if (requestEvent.kind !== "request") {
      throw new Error("expected request phase at index 3");
    }
    expect(requestEvent.params).toEqual({ message: "hi" });
    expect(requestEvent.requestId).toBe("req-phase");
    expect(requestEvent.method).toBe("host.echo");

    const responseEvent = seen[4];
    if (responseEvent.kind !== "response") {
      throw new Error("expected response phase at index 4");
    }
    expect(responseEvent.error).toBeNull();
    expect(responseEvent.result).toEqual({ echoed: "HI" });
  });

  it("emits response then close even when the handler throws", async () => {
    const messenger = new MockHostMessenger<typeof registry>({
      registry,
      handlers: {
        "host.echo": () => {
          throw new Error("boom");
        },
      },
      requestId: () => "req-phase-err",
    });

    await expect(
      messenger.request("host.echo", { message: "x" }),
    ).rejects.toBeInstanceOf(HostRpcError);

    const kinds = messenger.phases.map((event) => event.kind);
    expect(kinds).toEqual([
      "open",
      "auth",
      "manifest",
      "request",
      "response",
      "close",
    ]);

    const responseEvent = messenger.phases[4];
    if (responseEvent.kind !== "response") {
      throw new Error("expected response phase at index 4");
    }
    expect(responseEvent.error).toBeInstanceOf(HostRpcError);
    expect(responseEvent.result).toBeNull();
  });
});
