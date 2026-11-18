import { expect, vi } from "vitest";
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { SERVES_EVERY_INSTALLED_MAJOR } from "@traycer/protocol/framework/capability-manifest";
import { buildStreamManifest } from "@traycer/protocol/framework/stream-compat";
import {
  identityFromAuthenticatedUser,
  type RequestContext,
} from "@traycer/protocol/auth/request-context";
import type { BearerSourceProvider } from "@traycer-clients/shared/auth/bearer-source";
import { DefaultRequestContextProvider } from "@traycer-clients/shared/auth/request-context-provider";
import { createWhatwgWebSocketFactory } from "../host-transport/whatwg-ws-factory";
import { hostDialGate } from "../host-transport/ws-dial-gate";
import { createAuthenticatedUserFixture } from "./authenticated-user";

/**
 * Fixtures for tests that drive a real transport through the process-wide
 * dial gate over a fake global `WebSocket`: the fake socket, the gate-holder
 * setup, and the signed-in user helpers.
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

/**
 * A sign-in no `/api/v3/user` call has confirmed: the context's bearer is
 * live but its cloud verdict is false until something promotes it.
 */
export function signInUnverified(
  provider: DefaultRequestContextProvider,
  userId: string,
  bearerToken: string,
): void {
  provider.setUnverified({
    identity: identityFromAuthenticatedUser(userFixture(userId)),
    bearerToken,
  });
}

/** The verdict a composition root wires: whatever the current context says. */
export function cloudVerdictOf(
  provider: DefaultRequestContextProvider,
): () => boolean {
  return () => provider.current()?.cloudAuthorized ?? false;
}

/** The active context, for a test that changes its verdict in place. */
export function requireContext(
  provider: DefaultRequestContextProvider,
): RequestContext {
  const context = provider.current();
  if (context === null) {
    throw new Error("Expected a signed-in context");
  }
  return context;
}

/** Every token any frame sent on any fake socket carried, in send order. */
export function sentTokens(): unknown[] {
  const tokens: unknown[] = [];
  for (const native of FakeNativeWebSocket.instances) {
    for (const raw of native.sent) {
      const frame: unknown = JSON.parse(raw);
      if (typeof frame === "object" && frame !== null && "token" in frame) {
        tokens.push(frame.token);
      }
    }
  }
  return tokens;
}

/** The decoded control frames of one kind a client sent on one fake socket. */
export function sentFramesOfKind(
  native: FakeNativeWebSocket,
  kind: string,
): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = [];
  for (const raw of native.sent) {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "kind" in parsed) {
      if (parsed.kind === kind) {
        frames.push({ ...parsed });
      }
    }
  }
  return frames;
}

/** Every `cloudAuthorized` value the client sent as a `cloudVerdictUpdate`. */
export function verdictUpdatesSent(native: FakeNativeWebSocket): unknown[] {
  return sentFramesOfKind(native, "cloudVerdictUpdate").map(
    (frame) => frame.cloudAuthorized,
  );
}

/** A host `openAck` advertising `capabilities`, reporting `hostCredentialState`. */
export function openAckFrame(
  capabilities: readonly string[],
  hostCredentialState: string | null,
): string {
  return JSON.stringify({
    kind: "openAck",
    manifest: buildStreamManifest(
      hostStreamRpcRegistry,
      SERVES_EVERY_INSTALLED_MAJOR,
    ),
    capabilities,
    hostCredentialState,
  });
}
