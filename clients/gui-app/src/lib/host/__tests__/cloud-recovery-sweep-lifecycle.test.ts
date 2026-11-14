import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import { sweepTransientCloudFailures } from "@/lib/host/cloud-recovery-sweep";
import {
  RetryingRead,
  ScriptedRead,
  heldFailure,
  hostFailure,
  hostReadKey,
  rejects,
  resolves,
} from "@/lib/host/test-support/cloud-failure-reads";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import {
  HeldTimers,
  type HeldTimer,
} from "@/lib/host/test-support/held-timers";
import {
  HOST,
  STRANDED_READS,
  clearClients,
  failedRead,
  freshClient,
  ownReAsk,
  quiet,
  refetchElsewhere,
  turn,
  waitUntil,
} from "@/lib/host/test-support/cloud-recovery-sweep-support";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  clearClients();
});

describe("sweepTransientCloudFailures over a read's lifecycle", () => {
  describe.each(STRANDED_READS)(
    "a removed read's sweep continuation, read $label",
    (variant) => {
      const { method, base, refused, strand } = variant;

      /** A read R whose sweep re-ask is held, with a second ring owed to it. */
      async function staleSweepOverRead(client: QueryClient): Promise<{
        old: ScriptedRead;
        oldAnswer: { readonly release: () => void };
        first: Promise<void>;
        second: Promise<void>;
      }> {
        const oldAnswer = heldFailure(refused());
        const { read: old, first } = await ownReAsk(
          client,
          variant,
          oldAnswer.answer,
        );
        const second = sweepTransientCloudFailures(client, HOST);
        return { old, oldAnswer, first, second };
      }

      /** What unmounting R's reader and gc do to its cache entry. */
      function retire(client: QueryClient, old: ScriptedRead): void {
        old.release();
        client.removeQueries({ queryKey: old.queryKey, exact: true });
      }

      it("neither restarts the replacement's pending request nor spends its owed ring", async () => {
        const client = freshClient();
        const { old, oldAnswer, first, second } =
          await staleSweepOverRead(client);
        const replacementAnswer = heldFailure(refused());

        retire(client, old);
        const replacement = new ScriptedRead(
          client,
          old.queryKey,
          replacementAnswer.answer,
        );
        const ring = sweepTransientCloudFailures(client, HOST);
        await turn();

        // The old continuation has run: the replacement still has its one request.
        expect(replacement.calls).toBe(1);
        replacement.answer = resolves("recovered");
        replacementAnswer.release();
        oldAnswer.release();
        await Promise.all([first, second, ring]);
        await waitUntil(() => expect(replacement.state.data).toBe("recovered"));
        await quiet(client);

        // Its owed ring was spent on one re-ask when its refusal settled.
        expect(replacement.calls).toBe(2);
      });

      it("leaves nothing behind when the read is removed and not replaced", async () => {
        const client = freshClient();
        const { old, oldAnswer, first, second } =
          await staleSweepOverRead(client);

        retire(client, old);
        oldAnswer.release();
        await Promise.all([first, second]);
        await quiet(client);

        expect(old.calls).toBe(base + 1);
        expect(client.getQueryCache().find({ queryKey: old.queryKey })).toBe(
          undefined,
        );
        const later = await failedRead(client, {
          hostId: HOST,
          method: "bot.list",
          name: "later",
          code: "E_CLOUD_REQUEST_REFUSED",
        });
        later.answer = resolves("ok");
        await sweepTransientCloudFailures(client, HOST);
        expect(later.calls).toBe(2);
        expect(later.state.data).toBe("ok");
      });

      it("treats a replacement mounted after the continuation unwound as any read", async () => {
        const client = freshClient();
        const { old, oldAnswer, first, second } =
          await staleSweepOverRead(client);
        retire(client, old);
        oldAnswer.release();
        await Promise.all([first, second]);
        await quiet(client);

        const replacementAnswer = heldFailure(refused());
        const replacement = new ScriptedRead(
          client,
          old.queryKey,
          replacementAnswer.answer,
        );
        await waitUntil(() => expect(replacement.calls).toBe(1));
        const ring = sweepTransientCloudFailures(client, HOST);
        expect(replacement.calls).toBe(1);
        replacement.answer = resolves("recovered");
        replacementAnswer.release();
        await ring;
        await waitUntil(() => expect(replacement.state.data).toBe("recovered"));
        await quiet(client);

        expect(replacement.calls).toBe(2);
      });

      it("retires when the read is removed while its sweep is still cancelling, leaving the replacement's request alone", async () => {
        const client = freshClient();
        const read = await strand(client);
        const replacementAnswer = heldFailure(refused());

        const first = sweepTransientCloudFailures(client, HOST);
        retire(client, read);
        const replacement = new ScriptedRead(
          client,
          read.queryKey,
          replacementAnswer.answer,
        );
        await turn();

        expect(replacement.calls).toBe(1);
        expect(replacement.state.fetchStatus).toBe("fetching");
        // Not invalidated either: an invalidate by key would have marked it.
        expect(replacement.state.isInvalidated).toBe(false);
        replacementAnswer.release();
        await first;
        await quiet(client);

        expect(replacement.calls).toBe(1);
      });

      it("retires when a cache subscriber replaces the read as its owed ring is spent, leaving the replacement's request alone", async () => {
        const client = freshClient();
        const attempt = heldFailure(refused());
        const { read, retry } = await refetchElsewhere(
          client,
          variant,
          attempt.answer,
        );
        const ring = sweepTransientCloudFailures(client, HOST);

        // The cache tells it about the attempt's end before the attempt's own
        // settlement spends the ring, so the read is replaced by the time the
        // ring's re-ask starts.
        const replacementAnswer = heldFailure(refused());
        const replaced: { read: ScriptedRead | null } = { read: null };
        const stopReplacing = client.getQueryCache().subscribe((event) => {
          if (
            replaced.read !== null ||
            event.type !== "updated" ||
            event.query.queryKey !== read.queryKey ||
            event.query.state.fetchStatus === "fetching"
          ) {
            return;
          }
          retire(client, read);
          replaced.read = new ScriptedRead(
            client,
            read.queryKey,
            replacementAnswer.answer,
          );
        });
        attempt.release();
        await Promise.all([retry, ring]);
        await turn();
        stopReplacing();

        const mounted = replaced.read;
        if (mounted === null) throw new Error("the read was not replaced");
        expect(mounted.calls).toBe(1);
        expect(mounted.state.fetchStatus).toBe("fetching");
        replacementAnswer.release();
        await quiet(client);
        expect(mounted.calls).toBe(1);
      });

      it("keeps the replacement's owed ring when the removed read is only now dropped by gc", async () => {
        const client = freshClient();
        client.setQueryDefaults(variant.queryKey, { gcTime: 0 });
        const read = await strand(client);
        // Removed from the cache while its reader still holds it.
        client.removeQueries({ queryKey: read.queryKey, exact: true });
        const replacementAnswer = heldFailure(refused());
        const replacement = new ScriptedRead(
          client,
          read.queryKey,
          replacementAnswer.answer,
        );
        await waitUntil(() => expect(replacement.calls).toBe(1));
        const ring = sweepTransientCloudFailures(client, HOST);

        // The old reader lets go: gc announces its removal though the
        // replacement now holds the slot.
        read.release();
        await turn();
        replacement.answer = resolves("recovered");
        replacementAnswer.release();
        await ring;
        await waitUntil(() => expect(replacement.state.data).toBe("recovered"));
        await quiet(client);

        expect(replacement.calls).toBe(2);
      });

      it("does not touch a read under another key", async () => {
        const client = freshClient();
        const { old, oldAnswer, first, second } =
          await staleSweepOverRead(client);
        const otherAnswer = heldFailure(refused());
        const other = new ScriptedRead(
          client,
          hostReadKey(HOST, method, "another-key"),
          otherAnswer.answer,
        );

        retire(client, old);
        const ring = sweepTransientCloudFailures(client, HOST);
        await turn();

        expect(other.calls).toBe(1);
        other.answer = resolves("recovered");
        otherAnswer.release();
        oldAnswer.release();
        await Promise.all([first, second, ring]);
        await waitUntil(() => expect(other.state.data).toBe("recovered"));
        await quiet(client);

        expect(other.calls).toBe(2);
      });
    },
  );

  describe.each(STRANDED_READS)(
    "a reset or clear of a read with a ring owed, read $label",
    (variant) => {
      const { base, refused } = variant;

      it("drops the ring remembered for a read that is reset, whose own refetch is its next attempt", async () => {
        const client = freshClient();
        const attempt = heldFailure(refused());
        const { read, retry } = await refetchElsewhere(
          client,
          variant,
          attempt.answer,
        );
        const ring = sweepTransientCloudFailures(client, HOST);

        // The reset's refetch is refused too: a ring still remembered would
        // be spent on it as one more ask.
        read.answer = rejects(refused());
        await client.resetQueries({ queryKey: read.queryKey, exact: true });
        attempt.release();
        await Promise.all([retry, ring]);
        await quiet(client);

        expect(read.calls).toBe(base + 2);
      });

      it("does not loop on a ring owed to a read reset during the sweep's own re-ask, and frees it for a later ring", async () => {
        const client = freshClient();
        const attempt = heldFailure(refused());
        const { read, first } = await ownReAsk(client, variant, attempt.answer);
        const second = sweepTransientCloudFailures(client, HOST);

        read.answer = rejects(refused());
        await client.resetQueries({ queryKey: read.queryKey, exact: true });
        attempt.release();
        await Promise.all([first, second]);
        await quiet(client);

        expect(read.calls).toBe(base + 2);
        expect(read.state.status).toBe("error");
        read.answer = resolves("recovered");
        await sweepTransientCloudFailures(client, HOST);
        await quiet(client);

        expect(read.calls).toBe(base + 3);
        expect(read.state.data).toBe("recovered");
      });

      // A refetch with cancelRefetch replaces a data-holding read's attempt
      // with a new one, and joins a no-data read's attempt in flight. A ring
      // owed for the attempt it met is spent only when THAT attempt ends:
      // replaced, it is not spent on the new attempt's end; joined, it is.
      it("spends a ring owed during the sweep's own re-ask only on the attempt it met, when a refetch comes in", async () => {
        const client = freshClient();
        const attempt = heldFailure(refused());
        const { read, first } = await ownReAsk(client, variant, attempt.answer);
        const second = sweepTransientCloudFailures(client, HOST);

        // Used by the refetch's attempt, or by the ask the ring spends.
        read.answer = rejects(refused());
        const refetch = client.refetchQueries({
          queryKey: read.queryKey,
          exact: true,
        });
        await turn();
        attempt.release();
        await Promise.all([first, second, refetch]);
        await quiet(client);

        expect(read.calls).toBe(base + 2);
        expect(read.state.status).toBe("error");
        read.answer = resolves("recovered");
        await sweepTransientCloudFailures(client, HOST);
        await quiet(client);

        expect(read.calls).toBe(base + 3);
        expect(read.state.data).toBe("recovered");
      });

      it("spends a ring owed during a refetch from elsewhere only on the attempt it met, when a second refetch comes in", async () => {
        const client = freshClient();
        const attempt = heldFailure(refused());
        const { read, retry: firstRefetch } = await refetchElsewhere(
          client,
          variant,
          attempt.answer,
        );
        const ring = sweepTransientCloudFailures(client, HOST);

        read.answer = rejects(refused());
        const secondRefetch = client.refetchQueries({
          queryKey: read.queryKey,
          exact: true,
        });
        await turn();
        attempt.release();
        await Promise.all([firstRefetch, secondRefetch, ring]);
        await quiet(client);

        expect(read.calls).toBe(base + 2);
        expect(read.state.status).toBe("error");
        read.answer = resolves("recovered");
        await sweepTransientCloudFailures(client, HOST);
        await quiet(client);

        expect(read.calls).toBe(base + 3);
        expect(read.state.data).toBe("recovered");
      });

      it("re-asks nothing when the cache is cleared with a ring owed", async () => {
        const client = freshClient();
        const attempt = heldFailure(refused());
        const { read, first } = await ownReAsk(client, variant, attempt.answer);
        const second = sweepTransientCloudFailures(client, HOST);

        client.clear();
        read.release();
        attempt.release();
        await Promise.all([first, second]);
        await quiet(client);

        expect(read.calls).toBe(base + 1);
        expect(client.getQueryCache().getAll()).toHaveLength(0);
      });
    },
  );

  describe.each(STRANDED_READS)(
    "a cancel of the host's reads with nothing after it, read $label",
    (variant) => {
      const { base, data, refused } = variant;

      async function cancelHostReads(client: QueryClient): Promise<void> {
        const port = createHostQueryInvalidator(client);
        if (port.cancelHostScope === undefined) {
          throw new Error("the invalidator has no cancel port");
        }
        await port.cancelHostScope(HOST);
      }

      /** The read is back at its earlier failure, and a later ring asks it exactly once. */
      async function expectEarlierStateThenOneAsk(
        client: QueryClient,
        read: ScriptedRead,
      ): Promise<void> {
        expect(read.calls).toBe(base + 1);
        expect(read.state.status).toBe("error");
        expect(read.state.data).toBe(data);
        read.answer = resolves("recovered");
        await sweepTransientCloudFailures(client, HOST);
        await quiet(client);

        expect(read.calls).toBe(base + 2);
        expect(read.state.data).toBe("recovered");
      }

      it.each([true, false])(
        "spends no ring on the read's earlier failure when the sweep's own re-ask is cancelled (ring owed: %s)",
        async (owed) => {
          const client = freshClient();
          const attempt = heldFailure(refused());
          const { read, first } = await ownReAsk(
            client,
            variant,
            attempt.answer,
          );
          const second = owed
            ? sweepTransientCloudFailures(client, HOST)
            : Promise.resolve();

          // Any ask from here on would recover the read.
          read.answer = resolves("unexpected");
          await cancelHostReads(client);
          attempt.release();
          await Promise.all([first, second]);
          await quiet(client);

          await expectEarlierStateThenOneAsk(client, read);
        },
      );

      it.each([true, false])(
        "spends no ring on the read's earlier failure when a refetch from elsewhere is cancelled (ring owed: %s)",
        async (owed) => {
          const client = freshClient();
          const attempt = heldFailure(refused());
          const { read, retry: refetch } = await refetchElsewhere(
            client,
            variant,
            attempt.answer,
          );
          const ring = owed
            ? sweepTransientCloudFailures(client, HOST)
            : Promise.resolve();

          read.answer = resolves("unexpected");
          await cancelHostReads(client);
          attempt.release();
          await Promise.all([refetch, ring]);
          await quiet(client);

          await expectEarlierStateThenOneAsk(client, read);
        },
      );
    },
  );

  describe.each(STRANDED_READS)(
    "a newer attempt that starts as an earlier one's failure is dispatched, read $label",
    (variant) => {
      const { base, refused, strand } = variant;

      /** Runs `react` once, in the notification that announces the read has stopped fetching. */
      function onNextSettle(
        client: QueryClient,
        read: ScriptedRead,
        react: () => void,
      ): { readonly fired: () => boolean; readonly stop: () => void } {
        let fired = false;
        const stop = client.getQueryCache().subscribe((event) => {
          if (
            fired ||
            event.type !== "updated" ||
            event.query.queryKey !== read.queryKey ||
            event.query.state.fetchStatus !== "idle"
          ) {
            return;
          }
          fired = true;
          react();
        });
        return { fired: () => fired, stop };
      }

      it.each([
        { claimed: true, owed: true },
        { claimed: false, owed: true },
        { claimed: true, owed: false },
        { claimed: false, owed: false },
      ])(
        "leaves another refetch started after the failure alone (claimed: $claimed, ring owed: $owed)",
        async ({ claimed, owed }) => {
          const client = freshClient();
          const read = await strand(client);
          const x = heldFailure(refused());
          read.answer = x.answer;
          const first = claimed
            ? sweepTransientCloudFailures(client, HOST)
            : client.refetchQueries({ queryKey: read.queryKey, exact: true });
          await waitUntil(() => expect(read.calls).toBe(base + 1));
          if (owed) await sweepTransientCloudFailures(client, HOST);
          const y = heldFailure(refused());
          let restart: Promise<void> = Promise.resolve();
          const hook = onNextSettle(client, read, () => {
            read.answer = y.answer;
            restart = client.refetchQueries({
              queryKey: read.queryKey,
              exact: true,
            });
          });
          x.release();
          await waitUntil(() => expect(hook.fired()).toBe(true));
          expect.soft(read.calls).toBe(base + 2);
          hook.stop();
          y.release();
          await Promise.all([first, restart]);
          await quiet(client);

          expect(read.calls).toBe(base + 2);
        },
      );

      it("keeps the ring a newer attempt met when the earlier attempt's re-ask unwinds", async () => {
        const client = freshClient();
        const x = heldFailure(refused());
        const { read, first } = await ownReAsk(client, variant, x.answer);
        const y = heldFailure(refused());
        let restart: Promise<void> = Promise.resolve();
        let ring: Promise<void> = Promise.resolve();
        const hook = onNextSettle(client, read, () => {
          queueMicrotask(() => {
            read.answer = y.answer;
            restart = client.refetchQueries({
              queryKey: read.queryKey,
              exact: true,
            });
            ring = sweepTransientCloudFailures(client, HOST);
          });
        });
        x.release();
        await first;
        expect(read.calls).toBe(base + 2);
        hook.stop();
        read.answer = resolves("recovered");
        y.release();
        await Promise.all([restart, ring]);
        await quiet(client);

        expect.soft(read.calls).toBe(base + 3);
        expect.soft(read.state.data).toBe("recovered");
      });

      it("asks a ring that arrives once the claimed ask has failed, before its sweep has released the read", async () => {
        const client = freshClient();
        const x = heldFailure(refused());
        const { read, first } = await ownReAsk(client, variant, x.answer);
        let ring: Promise<void> = Promise.resolve();
        const hook = onNextSettle(client, read, () => {
          queueMicrotask(() => {
            read.answer = resolves("recovered");
            ring = sweepTransientCloudFailures(client, HOST);
          });
        });
        x.release();
        await first;
        hook.stop();
        await ring;
        await quiet(client);

        expect.soft(read.calls).toBe(base + 2);
        expect.soft(read.state.data).toBe("recovered");
      });

      it.each([
        {
          how: "throws",
          fail: (): Promise<string> => {
            throw refused();
          },
        },
        { how: "rejects", fail: () => Promise.reject(refused()) },
      ])(
        "keeps a second sweep's claim owned while an attempt that $how at once unwinds the first",
        async ({ fail }) => {
          const client = freshClient();
          const read = await strand(client);
          const x = heldFailure(refused());
          const z = heldFailure(refused());
          const w = heldFailure(refused());
          read.answer = x.answer;
          let stage = 0;
          let second: Promise<void> = Promise.resolve();
          let secondDone = false;
          // X fails, and a refetch whose ask fails at once starts; its failure
          // starts a second sweep, whose re-ask asks Z.
          const stop = client.getQueryCache().subscribe((event) => {
            if (
              event.type !== "updated" ||
              event.query.queryKey !== read.queryKey ||
              event.query.state.fetchStatus !== "idle"
            ) {
              return;
            }
            if (stage === 0) {
              stage = 1;
              read.answer = fail;
              void client.refetchQueries({
                queryKey: read.queryKey,
                exact: true,
              });
            } else if (stage === 1) {
              stage = 2;
              read.answer = z.answer;
              second = sweepTransientCloudFailures(client, HOST).then(() => {
                secondDone = true;
              });
            }
          });
          const first = sweepTransientCloudFailures(client, HOST);
          await waitUntil(() => expect(read.calls).toBe(base + 1));
          x.release();
          await first;
          await waitUntil(() => expect(read.calls).toBe(base + 3));
          stop();
          await sweepTransientCloudFailures(client, HOST);
          read.answer = w.answer;
          z.release();
          await waitUntil(() => expect(read.calls).toBe(base + 4));
          expect.soft(secondDone).toBe(false);
          w.release();
          await second;

          expect(secondDone).toBe(true);
          expect(read.calls).toBe(base + 4);
        },
      );

      it("does not resolve a claimed sweep while its spent re-ask is held", async () => {
        const client = freshClient();
        const x = heldFailure(refused());
        const y = heldFailure(refused());
        const { read, first: sweep } = await ownReAsk(
          client,
          variant,
          x.answer,
        );
        let finished = false;
        const first = sweep.then(() => {
          finished = true;
        });
        await sweepTransientCloudFailures(client, HOST);
        read.answer = y.answer;
        x.release();
        await waitUntil(() => expect(read.calls).toBe(base + 2));
        expect.soft(finished).toBe(false);
        y.release();
        await first;

        expect(finished).toBe(true);
        expect(read.calls).toBe(base + 2);
      });
    },
  );
});

describe("sweepTransientCloudFailures under the app's retry policy", () => {
  /** The backoff TanStack waits between a failed try and its retry. */
  const BACKOFF_MS = 1000;
  const timers = new HeldTimers();
  const refused = (): Error =>
    hostFailure("E_CLOUD_REQUEST_REFUSED", "bot.thread.list");

  beforeEach(() => {
    timers.install();
  });
  afterEach(() => {
    timers.restore();
  });

  function backoffs(): HeldTimer[] {
    return timers.pending().filter((timer) => timer.delay === BACKOFF_MS);
  }

  /** Ends the one backoff that is held, as a named event. */
  function endBackoff(): void {
    const held = backoffs();
    if (held.length !== 1)
      throw new Error("exactly one backoff should be held");
    timers.fire(held[0]);
  }

  it("lets a ring owed to an attempt in retry backoff wait for its retry", async () => {
    const client = freshClient();
    const read = new RetryingRead(
      client,
      hostReadKey(HOST, "bot.thread.list", "backoff"),
      resolves("first"),
    );
    await waitUntil(() => expect(read.state.data).toBe("first"));
    // A data-holding read whose refetch failed twice: its try, then its retry.
    read.answer = rejects(refused());
    const stranding = client.refetchQueries({ queryKey: read.queryKey });
    await waitUntil(() => expect(backoffs()).toHaveLength(1));
    endBackoff();
    await stranding;
    expect(read.state.status).toBe("error");
    expect(read.calls).toBe(3);

    // R1 asks A1; a refetch from elsewhere replaces it with A2; a ring is owed
    // to A2.
    const a1 = heldFailure(refused());
    read.answer = a1.answer;
    const sweep = sweepTransientCloudFailures(client, HOST);
    await waitUntil(() => expect(read.calls).toBe(4));
    const a2 = heldFailure(refused());
    read.answer = a2.answer;
    const refetch = client.refetchQueries({
      queryKey: read.queryKey,
      exact: true,
    });
    await waitUntil(() => expect(read.calls).toBe(5));
    const owed = sweepTransientCloudFailures(client, HOST);

    // A2's try fails and so does its retry: the ring is spent on A3, whose own
    // try fails at once and leaves A3 in backoff.
    read.answer = rejects(refused());
    a2.release();
    await waitUntil(() => expect(backoffs()).toHaveLength(1));
    endBackoff();
    await waitUntil(() => expect(read.calls).toBe(7));
    await waitUntil(() => expect(backoffs()).toHaveLength(1));
    await Promise.all([sweep, refetch, owed]);

    // A ring met in A3's backoff is owed to A3: it neither cancels the retry
    // nor asks, and the retry still goes out when the backoff ends.
    void sweepTransientCloudFailures(client, HOST);
    await turn();
    expect(read.calls).toBe(7);
    expect(backoffs()).toHaveLength(1);
    endBackoff();
    // The retry is the eighth ask; it fails too, which spends the ring on a
    // ninth.
    await waitUntil(() => expect(read.calls).toBe(9));
    await turn();
    expect(read.calls).toBe(9);
  });
});
