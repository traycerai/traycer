import type { QueryClient } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { vi } from "vitest";

export interface SecretRetentionHarness {
  readonly client: HostClient<HostRpcRegistry>;
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
  readonly queryClient: QueryClient;
}

export function createSecretRetentionHarness(
  handlers: MockHandlerMap<HostRpcRegistry>,
): SecretRetentionHarness {
  const queryClient = createAppQueryClient();
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    handlers,
    requestId: () => "req-secret-retention",
  });
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger,
  });
  client.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "synthetic-secret-retention-session",
    }),
  );
  return { client, messenger, queryClient };
}

export interface MutationObserverReference {
  readonly options: unknown;
  readonly getCurrentResult: () => unknown;
}

export function captureMutationObservers(
  queryClient: QueryClient,
  observers: MutationObserverReference[],
): void {
  const unsubscribe = queryClient.getMutationCache().subscribe((event) => {
    if (event.type === "observerAdded") observers.push(event.observer);
  });
  mutationCacheUnsubscribers.push(unsubscribe);
}

const mutationCacheUnsubscribers: Array<() => void> = [];
const consoleCaptureRestorers: Array<() => void> = [];

export function restoreMutationCacheObservers(): void {
  for (const unsubscribe of mutationCacheUnsubscribers.splice(0)) unsubscribe();
}

export function containsSyntheticInput(
  value: unknown,
  syntheticInputs: readonly string[],
): boolean {
  const seen = new WeakSet<object>();
  function contains(current: unknown): boolean {
    if (typeof current === "string") {
      return syntheticInputs.some((input) => current.includes(input));
    }
    if (
      (typeof current !== "object" && typeof current !== "function") ||
      current === null
    ) {
      return false;
    }
    if (seen.has(current)) return false;
    seen.add(current);
    if (
      current instanceof Error &&
      (syntheticInputs.some(
        (input) =>
          current.message.includes(input) ||
          (current.stack ?? "").includes(input),
      ) ||
        contains(current.cause))
    ) {
      return true;
    }
    return Object.values(current).some(contains);
  }
  return contains(value);
}

export function hasExactObjectKeys(
  value: unknown,
  expected: readonly string[],
): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    expected.every((key) => actual.includes(key))
  );
}

export function mutationStateContainsSyntheticInput(
  queryClient: QueryClient,
  observers: readonly MutationObserverReference[],
  syntheticInputs: readonly string[],
): boolean {
  return (
    queryClient
      .getMutationCache()
      .getAll()
      .some((mutation) =>
        containsSyntheticInput(
          {
            variables: mutation.state.variables,
            context: mutation.state.context,
            data: mutation.state.data,
            error: mutation.state.error,
            options: mutation.options,
          },
          syntheticInputs,
        ),
      ) ||
    observers.some((observer) =>
      containsSyntheticInput(
        { options: observer.options, result: observer.getCurrentResult() },
        syntheticInputs,
      ),
    )
  );
}

export interface ConsoleCapture {
  readonly output: unknown[][];
  readonly restore: () => void;
}

export function captureConsoleOutput(): ConsoleCapture {
  const output: unknown[][] = [];
  const debug = vi.spyOn(console, "debug").mockImplementation((...values) => {
    output.push(values);
  });
  const info = vi.spyOn(console, "info").mockImplementation((...values) => {
    output.push(values);
  });
  const log = vi.spyOn(console, "log").mockImplementation((...values) => {
    output.push(values);
  });
  const warn = vi.spyOn(console, "warn").mockImplementation((...values) => {
    output.push(values);
  });
  const error = vi.spyOn(console, "error").mockImplementation((...values) => {
    output.push(values);
  });
  const restore = (): void => {
    debug.mockRestore();
    info.mockRestore();
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  };
  consoleCaptureRestorers.push(restore);
  return { output, restore };
}

export function restoreConsoleCaptures(): void {
  for (const restore of consoleCaptureRestorers.splice(0)) restore();
}
