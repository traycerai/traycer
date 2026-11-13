import { expect, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import {
  ScriptedRead,
  hostFailure,
  hostReadKey,
  rejects,
  resolves,
} from "@/lib/host/test-support/cloud-failure-reads";
import { createAppQueryClient } from "@/lib/query-client";

export const HOST = "host-A";
export const OTHER_HOST = "host-B";

const clients: QueryClient[] = [];
export function freshClient(): QueryClient {
  const client = createAppQueryClient();
  clients.push(client);
  return client;
}

/** Clears every client `freshClient` built: call it from each file's `afterEach`. */
export function clearClients(): void {
  for (const client of clients.splice(0)) client.clear();
}

/**
 * Waits until `assertion` holds, polling every millisecond: the wait is for an
 * event the code emits, and a finer poll only ends it sooner.
 */
export function waitUntil(assertion: () => void): Promise<void> {
  return vi.waitFor(assertion, { interval: 1 });
}

export async function settled(client: QueryClient): Promise<void> {
  await waitUntil(() => expect(client.isFetching()).toBe(0));
}

/** One macrotask turn: what a settled attempt sets going has run. */
export function turn(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Lets what a settled attempt sets going run, and the cache go quiet. */
export async function quiet(client: QueryClient): Promise<void> {
  await settled(client);
  await turn();
  await settled(client);
}

/** A read of `method` that has failed with `code`, still observed. */
export async function failedRead(
  client: QueryClient,
  spec: {
    readonly hostId: string;
    readonly method: string;
    readonly name: string;
    readonly code: Parameters<typeof hostFailure>[0];
  },
): Promise<ScriptedRead> {
  const { hostId, method, name, code } = spec;
  const read = new ScriptedRead(
    client,
    hostReadKey(hostId, method, name),
    rejects(hostFailure(code, method)),
  );
  await waitUntil(() => expect(read.state.status).toBe("error"));
  return read;
}

/**
 * A read that holds data ("first") and whose refetch then failed with
 * `E_CLOUD_REQUEST_REFUSED`: status `error` with data, asked twice so far.
 * TanStack keeps that status through a re-ask, which is what makes such a
 * read a candidate for a second sweep while the first one's ask is open.
 */
export async function dataHoldingFailedRead(
  client: QueryClient,
  name: string,
): Promise<ScriptedRead> {
  const read = new ScriptedRead(
    client,
    hostReadKey(HOST, "bot.thread.list", name),
    resolves("first"),
  );
  await waitUntil(() => expect(read.state.data).toBe("first"));
  read.answer = rejects(
    hostFailure("E_CLOUD_REQUEST_REFUSED", "bot.thread.list"),
  );
  await client.refetchQueries({ queryKey: read.queryKey });
  expect(read.state.status).toBe("error");
  expect(read.state.data).toBe("first");
  expect(read.calls).toBe(2);
  return read;
}

/** The stranded reads the in-flight cases run over: with data, and without. */
export const STRANDED_READS = [
  {
    label: "holds data",
    method: "bot.thread.list",
    /** Asks the read has had when it is stranded. */
    base: 2,
    /** What the stranded read holds. */
    data: "first" as string | undefined,
    strand: (client: QueryClient) => dataHoldingFailedRead(client, "o"),
  },
  {
    label: "holds no data",
    method: "bot.list",
    base: 1,
    data: undefined as string | undefined,
    strand: (client: QueryClient) =>
      failedRead(client, {
        hostId: HOST,
        method: "bot.list",
        name: "o",
        code: "E_CLOUD_REQUEST_REFUSED",
      }),
  },
];
