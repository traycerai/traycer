import { expect, vi } from "vitest";
import { z } from "zod";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import {
  defineRpcContract,
  defineVersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import type { BearerSourceProvider } from "@traycer-clients/shared/auth/bearer-source";
import { DefaultRequestContextProvider } from "@traycer-clients/shared/auth/request-context-provider";
import { createWhatwgWebSocketFactory } from "../host-transport/whatwg-ws-factory";
import { hostDialGate } from "../host-transport/ws-dial-gate";
import { createAuthenticatedUserFixture } from "./authenticated-user";

/**
 * Fixtures for tests that drive a real transport through the process-wide
 * dial gate over a fake global `WebSocket`: the fake socket, the gate-holder
 * setup, an echo contract, and the signed-in user helpers.
 */

export const GATE_SLOTS = 6;
export const QUEUED_FOR_MS = 15_000;
export const HOLDER_URL = "wss://holder.example.test/dial";
// Long enough that no liveness, redial, ping, ack or frame timer fires inside a test.
export const NEVER_MS = 600_000;

export const USER_A = "user-a";
export const USER_B = "user-b";

interface NativeEvent {
  readonly data: string | ArrayBuffer;
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

/** The global `WebSocket` a real whatwg factory builds once the gate grants a dial. */
export class FakeNativeWebSocket {
  static readonly instances: FakeNativeWebSocket[] = [];

  binaryType = "blob";
  readonly sent: string[] = [];
  closed: { readonly code: number; readonly reason: string } | null = null;
  private readonly listeners = new Map<
    string,
    Array<(event: NativeEvent) => void>
  >();

  constructor(readonly url: string) {
    FakeNativeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: NativeEvent) => void): void {
    const existing = this.listeners.get(type);
    if (existing === undefined) {
      this.listeners.set(type, [listener]);
    } else {
      existing.push(listener);
    }
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  fireOpen(): void {
    this.dispatch("open", { data: "", code: 0, reason: "", wasClean: true });
  }

  fireMessage(data: string | ArrayBuffer): void {
    this.dispatch("message", { data, code: 0, reason: "", wasClean: true });
  }

  fireClose(code: number, reason: string): void {
    this.dispatch("close", { data: "", code, reason, wasClean: false });
  }

  protected dispatch(type: string, event: NativeEvent): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const echoV10 = defineRpcContract({
  method: "host.echo",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({ message: z.string() }),
  responseSchema: z.object({ echoed: z.string() }),
});

export const echoRegistry = defineVersionedRpcRegistry({
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

export async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/**
 * Six dials through the real factory with no client attached, so nothing
 * times a holder out and every slot stays taken until a test closes or opens
 * one.
 */
export async function holdEveryGateSlot(): Promise<FakeNativeWebSocket[]> {
  const factory = createWhatwgWebSocketFactory();
  for (let slot = 0; slot < GATE_SLOTS; slot += 1) {
    factory.create(HOLDER_URL, "interactive");
  }
  await settle();
  expect(hostDialGate.stats().connecting).toBe(GATE_SLOTS);
  return FakeNativeWebSocket.instances.filter(
    (native) => native.url === HOLDER_URL,
  );
}

export function userFixture(userId: string): AuthenticatedUser {
  const base = createAuthenticatedUserFixture(undefined);
  return { ...base, user: { ...base.user, id: userId } };
}

export function newProvider(): DefaultRequestContextProvider {
  return new DefaultRequestContextProvider({ origin: "renderer" });
}

export function signIn(
  provider: DefaultRequestContextProvider,
  userId: string,
  bearerToken: string,
): void {
  provider.setSignedIn({
    user: userFixture(userId),
    bearerToken,
    operationId: undefined,
    externalAbortSignal: undefined,
  });
}

/** What a composition root wires: a live read of whichever context is current. */
export function liveBearer(
  provider: DefaultRequestContextProvider,
): BearerSourceProvider {
  return () => provider.current()?.credentials ?? null;
}
