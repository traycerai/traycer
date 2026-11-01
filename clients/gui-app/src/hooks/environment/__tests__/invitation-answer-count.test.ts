import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import {
  cancelEnvironmentInvitationReads,
  countEnvironmentInvitationAnswers,
} from "@/hooks/environment/use-environment-invitations";
import { authQueryKeys, hostQueryKeys } from "@/lib/query-keys";

/**
 * The invitations read lands in one of two cache slots — the host-RPC method
 * key, or the direct-authn key — and which one is serving follows host
 * readiness, so it can move inside a settings session. The removal gate's
 * evidence is "this read has answered since I asked", and it has to mean that
 * across both slots: an entry that was never fetched reports a `0` clock, and
 * an entry that answered before the question carries an older one, so a
 * comparison that only knows the slot it was sampled on can take the OTHER
 * slot's cached answer as a reply to a question it predates.
 *
 * These assert the counter the gate samples, on a real `QueryClient` with the
 * real key builders, because that is where the property lives.
 */

const RPC_KEY = hostQueryKeys.methodScope(
  "host-1",
  "environment.invitations.list",
);
const AUTH_KEY = [...authQueryKeys.environmentInvitationsAll(), "user-me"];

let client: QueryClient | null = null;

function freshClient(): QueryClient {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return client;
}

afterEach(() => {
  client?.clear();
  client = null;
});

describe("countEnvironmentInvitationAnswers", () => {
  it("counts an answer in either slot, and sums the two", async () => {
    const queryClient = freshClient();

    expect(countEnvironmentInvitationAnswers(queryClient)).toBe(0);

    await queryClient.fetchQuery({
      queryKey: RPC_KEY,
      queryFn: () => ({ invitations: [] }),
    });
    expect(countEnvironmentInvitationAnswers(queryClient)).toBe(1);

    await queryClient.fetchQuery({
      queryKey: AUTH_KEY,
      queryFn: () => ({ invitations: [] }),
    });
    expect(countEnvironmentInvitationAnswers(queryClient)).toBe(2);
  });

  // The route flip. The direct slot answered long before the question, and a
  // switch of serving route makes that stale answer the one the gate reads.
  // The count does not move, because nothing answered: serving cached data is
  // not a reply.
  it("does not move when a slot that answered earlier becomes the one being read", async () => {
    const queryClient = freshClient();
    await queryClient.fetchQuery({
      queryKey: AUTH_KEY,
      queryFn: () => ({ invitations: [] }),
    });
    await queryClient.fetchQuery({
      queryKey: RPC_KEY,
      queryFn: () => ({ invitations: [] }),
    });

    const atTheQuestion = countEnvironmentInvitationAnswers(queryClient);
    // Nothing is fetched here: the other slot's data is simply read, which is
    // all a route change does to it.
    expect(
      queryClient.getQueryData<{ readonly invitations: readonly unknown[] }>(
        AUTH_KEY,
      ),
    ).toEqual({ invitations: [] });

    expect(countEnvironmentInvitationAnswers(queryClient)).toBe(atTheQuestion);
  });

  // A failing read is not an answer: the gate must not confirm a removal on
  // one, and this is what keeps it from doing so.
  it("does not move on a read that failed", async () => {
    const queryClient = freshClient();
    await queryClient
      .fetchQuery({
        queryKey: RPC_KEY,
        queryFn: () => {
          throw new Error("down");
        },
      })
      .catch(() => undefined);

    expect(countEnvironmentInvitationAnswers(queryClient)).toBe(0);
  });

  // The cancel and the count are kept beside each other on one set of
  // matchers, so what gets cancelled is what gets counted. A cancel is not an
  // answer either.
  it("does not move when a read in flight is cancelled", async () => {
    const queryClient = freshClient();
    const held = Promise.withResolvers<{ readonly invitations: [] }>();
    void queryClient
      .fetchQuery({ queryKey: RPC_KEY, queryFn: () => held.promise })
      .catch(() => undefined);
    await Promise.resolve();

    cancelEnvironmentInvitationReads(queryClient);

    expect(countEnvironmentInvitationAnswers(queryClient)).toBe(0);
    held.resolve({ invitations: [] });
  });
});
