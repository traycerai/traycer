import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import {
  cancelEnvironmentInvitationReads,
  findEnvironmentInvitationEntry,
} from "@/hooks/environment/use-environment-invitations";
import { authQueryKeys, hostQueryKeys } from "@/lib/query-keys";

/**
 * The invitations read lands in one of two cache slots — the host-RPC method
 * key, or the direct-authn key — and which one serves follows host readiness,
 * so it can move inside a settings session. The removal gate's evidence is
 * "the read I am rendering has answered since I asked", and the entry is what
 * ties those two halves together: evidence gathered anywhere else can rise
 * while the list on screen is a cached one the question predates.
 *
 * These assert the resolution on a real `QueryClient` with the real key
 * builders and real observers, because that is where the property lives: the
 * serving entry is identified by the observers this app has on it, which is
 * what a rebuilt key, a stale host scope and a disabled slot differ on.
 */

const RPC_KEY = hostQueryKeys.methodScope(
  "host-1",
  "environment.invitations.list",
);
const AUTH_KEY = [...authQueryKeys.environmentInvitationsAll(), "user-me"];

let client: QueryClient | null = null;
const watching: (() => void)[] = [];

function freshClient(): QueryClient {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return client;
}

/**
 * An observer on `queryKey`, as the hook holds on its own slot's entry — and
 * on the slot that is not serving too, where `useQuery` still observes a query
 * it has disabled. It is disabled here so that every answer in these cases is
 * one the case itself asked for: an observer that fetches on its own would
 * raise the counts being asserted.
 */
function observe(queryClient: QueryClient, queryKey: readonly unknown[]): void {
  const observer = new QueryObserver(queryClient, {
    queryKey,
    queryFn: () => ({ invitations: [] }),
    enabled: false,
  });
  watching.push(observer.subscribe(() => undefined));
}

afterEach(() => {
  for (const unsubscribe of watching) unsubscribe();
  watching.length = 0;
  client?.clear();
  client = null;
});

describe("findEnvironmentInvitationEntry", () => {
  it("names the entry of the slot asked for, never the other slot's", async () => {
    const queryClient = freshClient();
    observe(queryClient, RPC_KEY);
    observe(queryClient, AUTH_KEY);
    await queryClient.fetchQuery({
      queryKey: AUTH_KEY,
      queryFn: () => ({ invitations: [] }),
    });

    expect(
      findEnvironmentInvitationEntry(queryClient, "rpc")?.queryKey,
    ).toEqual([...RPC_KEY]);
    expect(
      findEnvironmentInvitationEntry(queryClient, "direct")?.queryKey,
    ).toEqual(AUTH_KEY);
  });

  // What keeps a leftover from being mistaken for the serving entry: a host
  // scope or an identity that is no longer served keeps its data and loses its
  // observers, and an answer landing there says nothing about this page.
  it("names no entry that nothing is observing", async () => {
    const queryClient = freshClient();
    await queryClient.fetchQuery({
      queryKey: RPC_KEY,
      queryFn: () => ({ invitations: [] }),
    });

    expect(findEnvironmentInvitationEntry(queryClient, "rpc")).toBeNull();
  });

  // The entry can be replaced wholesale, which a sweep or a reclaim does. The
  // replacement counts its answers from zero, so a caller still holding the
  // old entry's number sees no rise however many times the new one answers —
  // it has to resolve the entry again, which is why the entry and not just the
  // count is the evidence.
  it("names the entry that replaced a dropped one, counting from zero again", async () => {
    const queryClient = freshClient();
    observe(queryClient, RPC_KEY);
    await queryClient.fetchQuery({
      queryKey: RPC_KEY,
      queryFn: () => ({ invitations: [] }),
    });
    const before = findEnvironmentInvitationEntry(queryClient, "rpc");
    expect(before?.state.dataUpdateCount).toBe(1);

    // Dropped, then observed and read again, as the page's own hook re-attaches
    // on the render after a sweep took the entry away.
    queryClient.removeQueries({ queryKey: RPC_KEY });
    observe(queryClient, RPC_KEY);
    await queryClient.fetchQuery({
      queryKey: RPC_KEY,
      queryFn: () => ({ invitations: [] }),
    });

    const after = findEnvironmentInvitationEntry(queryClient, "rpc");
    expect(after).not.toBe(before);
    // One answer on the entry that is there now, not two: evidence counted
    // against the entry that is gone can never be met.
    expect(after?.state.dataUpdateCount).toBe(1);
  });

  // A failing read is not an answer: the gate must not confirm a removal on
  // one, and this is what keeps it from doing so.
  it("counts no answer on a read that failed", async () => {
    const queryClient = freshClient();
    observe(queryClient, RPC_KEY);
    await queryClient
      .fetchQuery({
        queryKey: RPC_KEY,
        queryFn: () => {
          throw new Error("down");
        },
      })
      .catch(() => undefined);

    expect(
      findEnvironmentInvitationEntry(queryClient, "rpc")?.state.dataUpdateCount,
    ).toBe(0);
  });

  // The cancel and the resolution are built from the same slot filters, so
  // what gets cancelled is what gets watched. A reverting cancel restores the
  // pre-fetch state, so it cannot forge an answer either.
  it("counts no answer when a read in flight is cancelled", async () => {
    const queryClient = freshClient();
    observe(queryClient, RPC_KEY);
    const held = Promise.withResolvers<{ readonly invitations: [] }>();
    void queryClient
      .fetchQuery({ queryKey: RPC_KEY, queryFn: () => held.promise })
      .catch(() => undefined);
    await Promise.resolve();

    cancelEnvironmentInvitationReads(queryClient);

    expect(
      findEnvironmentInvitationEntry(queryClient, "rpc")?.state.dataUpdateCount,
    ).toBe(0);
    held.resolve({ invitations: [] });
  });
});
