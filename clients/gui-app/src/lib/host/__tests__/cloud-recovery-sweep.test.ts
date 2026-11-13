import { afterEach, describe, expect, it, vi } from "vitest";
import { MutationObserver, type QueryClient } from "@tanstack/react-query";
import { cloudQueryKeys } from "@/lib/query-keys/cloud-query-keys";
import { sweepTransientCloudFailures } from "@/lib/host/cloud-recovery-sweep";
import {
  ScriptedRead,
  heldAnswer,
  hostFailure,
  hostReadKey,
  heldFailure,
  rejects,
  resolves,
} from "@/lib/host/test-support/cloud-failure-reads";

import {
  HOST,
  OTHER_HOST,
  STRANDED_READS,
  clearClients,
  dataHoldingFailedRead,
  failedRead,
  freshClient,
  quiet,
  settled,
  turn,
  waitUntil,
} from "@/lib/host/test-support/cloud-recovery-sweep-support";

afterEach(clearClients);

describe("sweepTransientCloudFailures", () => {
  it.each(["E_CLOUD_REQUEST_REFUSED", "E_CLOUD_UNREACHABLE"] as const)(
    "re-asks an active read of the host that failed with %s, once",
    async (code) => {
      const client = freshClient();
      const read = await failedRead(client, {
        hostId: HOST,
        method: "bot.list",
        name: "a",
        code,
      });
      read.answer = resolves("recovered");

      await sweepTransientCloudFailures(client, HOST);

      expect(read.calls).toBe(2);
      expect(read.state.status).toBe("success");
      expect(read.state.data).toBe("recovered");
    },
  );

  it("re-asks a read that holds data and whose refetch failed transiently", async () => {
    const client = freshClient();
    const read = new ScriptedRead(
      client,
      hostReadKey(HOST, "bot.thread.list", "a"),
      resolves("first"),
    );
    await waitUntil(() => expect(read.state.data).toBe("first"));
    read.answer = rejects(
      hostFailure("E_CLOUD_REQUEST_REFUSED", "bot.thread.list"),
    );
    await client.refetchQueries({ queryKey: read.queryKey });
    expect(read.state.status).toBe("error");
    expect(read.state.data).toBe("first");
    read.answer = resolves("second");

    await sweepTransientCloudFailures(client, HOST);

    expect(read.calls).toBe(3);
    expect(read.state.data).toBe("second");
  });

  it("never re-asks another host's failed read", async () => {
    const client = freshClient();
    const mine = await failedRead(client, {
      hostId: HOST,
      method: "bot.list",
      name: "a",
      code: "E_CLOUD_UNREACHABLE",
    });
    const theirs = await failedRead(client, {
      hostId: OTHER_HOST,
      method: "bot.list",
      name: "a",
      code: "E_CLOUD_UNREACHABLE",
    });
    mine.answer = resolves("ok");
    theirs.answer = resolves("ok");

    await sweepTransientCloudFailures(client, HOST);

    expect(mine.calls).toBe(2);
    expect(theirs.calls).toBe(1);
    expect(theirs.state.status).toBe("error");
  });

  it.each(["FORBIDDEN", "RPC_ERROR"] as const)(
    "never re-asks a read that failed with %s",
    async (code) => {
      const client = freshClient();
      const permanent = await failedRead(client, {
        hostId: HOST,
        method: "bot.list",
        name: "p",
        code,
      });
      const transient = await failedRead(client, {
        hostId: HOST,
        method: "bot.list",
        name: "t",
        code: "E_CLOUD_REQUEST_REFUSED",
      });
      permanent.answer = resolves("ok");
      transient.answer = resolves("ok");

      await sweepTransientCloudFailures(client, HOST);

      expect(transient.calls).toBe(2);
      expect(permanent.calls).toBe(1);
      expect(permanent.state.status).toBe("error");
    },
  );

  it("never re-asks a successful read", async () => {
    const client = freshClient();
    const fine = new ScriptedRead(
      client,
      hostReadKey(HOST, "bot.list", "ok"),
      resolves("v"),
    );
    await waitUntil(() => expect(fine.state.status).toBe("success"));
    const failed = await failedRead(client, {
      hostId: HOST,
      method: "bot.list",
      name: "f",
      code: "E_CLOUD_UNREACHABLE",
    });
    failed.answer = resolves("ok");

    await sweepTransientCloudFailures(client, HOST);

    expect(failed.calls).toBe(2);
    expect(fine.calls).toBe(1);
  });

  it("never re-asks a read whose current attempt is in flight and has not failed", async () => {
    const client = freshClient();
    const held = heldAnswer("late");
    const inFlight = new ScriptedRead(
      client,
      hostReadKey(HOST, "bot.list", "slow"),
      held.answer,
    );
    const failed = await failedRead(client, {
      hostId: HOST,
      method: "bot.list",
      name: "f",
      code: "E_CLOUD_UNREACHABLE",
    });
    failed.answer = resolves("ok");

    await sweepTransientCloudFailures(client, HOST);
    expect(failed.calls).toBe(2);

    expect(inFlight.calls).toBe(1);
    held.release();
    await settled(client);
    expect(inFlight.state.data).toBe("late");
  });

  it("never re-asks the cache-only carve-outs", async () => {
    const client = freshClient();
    const models = await failedRead(client, {
      hostId: HOST,
      method: "agent.gui.listModels",
      name: "m",
      code: "E_CLOUD_UNREACHABLE",
    });
    const commands = await failedRead(client, {
      hostId: HOST,
      method: "agent.gui.listCommands",
      name: "c",
      code: "E_CLOUD_REQUEST_REFUSED",
    });
    const epicTasks = new ScriptedRead(
      client,
      cloudQueryKeys.epicTasks(HOST, "fp", {
        limit: 10,
        filters: null,
        extensionPhaseVersion: "p",
        extensionEpicVersion: "e",
      }),
      rejects(hostFailure("E_CLOUD_UNREACHABLE", "epic.listTasks")),
    );
    await waitUntil(() => expect(epicTasks.state.status).toBe("error"));
    const failed = await failedRead(client, {
      hostId: HOST,
      method: "bot.list",
      name: "f",
      code: "E_CLOUD_UNREACHABLE",
    });
    failed.answer = resolves("ok");

    await sweepTransientCloudFailures(client, HOST);
    expect(failed.calls).toBe(2);

    expect(models.calls).toBe(1);
    expect(commands.calls).toBe(1);
    expect(epicTasks.calls).toBe(1);
  });

  it("only marks an inactive failed read stale", async () => {
    const client = freshClient();
    const read = await failedRead(client, {
      hostId: HOST,
      method: "bot.list",
      name: "a",
      code: "E_CLOUD_UNREACHABLE",
    });
    read.release();
    read.answer = resolves("ok");
    const active = await failedRead(client, {
      hostId: HOST,
      method: "bot.list",
      name: "b",
      code: "E_CLOUD_UNREACHABLE",
    });
    active.answer = resolves("ok");

    await sweepTransientCloudFailures(client, HOST);
    expect(active.calls).toBe(2);

    expect(read.calls).toBe(1);
    expect(read.state.isInvalidated).toBe(true);
  });

  it("never re-sends a failed mutation that carries a transient code", async () => {
    const client = freshClient();
    const mutationFn = vi.fn(() =>
      Promise.reject(hostFailure("E_CLOUD_REQUEST_REFUSED", "bot.send")),
    );
    const observer = new MutationObserver(client, {
      mutationKey: ["host", HOST, "bot.send"],
      mutationFn,
      retry: false,
    });
    await observer.mutate(undefined).catch(() => undefined);
    const read = await failedRead(client, {
      hostId: HOST,
      method: "bot.list",
      name: "a",
      code: "E_CLOUD_UNREACHABLE",
    });
    read.answer = resolves("ok");

    await sweepTransientCloudFailures(client, HOST);
    expect(read.calls).toBe(2);

    expect(mutationFn).toHaveBeenCalledTimes(1);
  });

  it("asks each of N failed reads exactly once, and a second sweep during those asks adds none", async () => {
    const client = freshClient();
    const reads: ScriptedRead[] = [];
    for (const name of ["a", "b", "c", "d", "e"]) {
      reads.push(
        await failedRead(client, {
          hostId: HOST,
          method: "bot.list",
          name,
          code: "E_CLOUD_REQUEST_REFUSED",
        }),
      );
    }
    const held = heldAnswer("ok");
    for (const read of reads) read.answer = held.answer;

    const first = sweepTransientCloudFailures(client, HOST);
    await waitUntil(() =>
      expect(reads.map((read) => read.calls)).toEqual([2, 2, 2, 2, 2]),
    );
    const repeats = [
      sweepTransientCloudFailures(client, HOST),
      sweepTransientCloudFailures(client, HOST),
    ];
    held.release();
    await Promise.all([first, ...repeats]);

    expect(reads.map((read) => read.calls)).toEqual([2, 2, 2, 2, 2]);
  });

  it("asks each of N reads that hold data and failed a refetch exactly once, whatever sweeps follow", async () => {
    const client = freshClient();
    const reads: ScriptedRead[] = [];
    for (const name of ["a", "b", "c", "d", "e"]) {
      const read = new ScriptedRead(
        client,
        hostReadKey(HOST, "bot.thread.list", name),
        resolves("ok"),
      );
      await waitUntil(() => expect(read.state.data).toBe("ok"));
      read.answer = rejects(
        hostFailure("E_CLOUD_REQUEST_REFUSED", "bot.thread.list"),
      );
      await client.refetchQueries({ queryKey: read.queryKey });
      expect(read.state.status).toBe("error");
      expect(read.state.data).toBe("ok");
      reads.push(read);
    }
    const held = heldAnswer("ok");
    for (const read of reads) read.answer = held.answer;

    const first = sweepTransientCloudFailures(client, HOST);
    await waitUntil(() =>
      expect(reads.map((read) => read.calls)).toEqual([3, 3, 3, 3, 3]),
    );
    const repeats = [
      sweepTransientCloudFailures(client, HOST),
      sweepTransientCloudFailures(client, HOST),
    ];
    held.release();
    await Promise.all([first, ...repeats]);

    expect(reads.map((read) => read.calls)).toEqual([3, 3, 3, 3, 3]);
  });

  describe("rings that arrive before an earlier sweep has begun its re-asks", () => {
    it("re-asks a data-holding failed read once for two sweeps in one tick", async () => {
      const client = freshClient();
      const read = await dataHoldingFailedRead(client, "a");
      const held = heldAnswer("recovered");
      read.answer = held.answer;

      const first = sweepTransientCloudFailures(client, HOST);
      const second = sweepTransientCloudFailures(client, HOST);
      await waitUntil(() => expect(read.calls).toBeGreaterThan(2));
      held.release();
      await Promise.all([first, second]);

      expect(read.calls).toBe(3);
      expect(read.state.data).toBe("recovered");
    });

    it("re-asks a failed read with no data once for two sweeps in one tick", async () => {
      const client = freshClient();
      const read = await failedRead(client, {
        hostId: HOST,
        method: "bot.list",
        name: "a",
        code: "E_CLOUD_REQUEST_REFUSED",
      });
      const held = heldAnswer("recovered");
      read.answer = held.answer;

      const first = sweepTransientCloudFailures(client, HOST);
      const second = sweepTransientCloudFailures(client, HOST);
      await waitUntil(() => expect(read.calls).toBeGreaterThan(1));
      held.release();
      await Promise.all([first, second]);

      expect(read.calls).toBe(2);
      expect(read.state.data).toBe("recovered");
    });

    it("re-asks each of five data-holding failed reads once for five sweeps in one tick", async () => {
      const client = freshClient();
      const reads: ScriptedRead[] = [];
      for (const name of ["a", "b", "c", "d", "e"]) {
        reads.push(await dataHoldingFailedRead(client, name));
      }
      const held = heldAnswer("recovered");
      for (const read of reads) read.answer = held.answer;

      const sweeps = [1, 2, 3, 4, 5].map(() =>
        sweepTransientCloudFailures(client, HOST),
      );
      await waitUntil(() =>
        expect(reads.every((read) => read.calls > 2)).toBe(true),
      );
      held.release();
      await Promise.all(sweeps);

      expect(reads.map((read) => read.calls)).toEqual([3, 3, 3, 3, 3]);
      expect(reads.map((read) => read.state.data)).toEqual(
        reads.map(() => "recovered"),
      );
    });

    it.each([0, 1, 2, 3, 5])(
      "re-asks a data-holding failed read once when a second sweep follows %i microtask turns later",
      async (turns) => {
        const client = freshClient();
        const read = await dataHoldingFailedRead(client, "a");
        const held = heldAnswer("recovered");
        read.answer = held.answer;

        const first = sweepTransientCloudFailures(client, HOST);
        for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
        const second = sweepTransientCloudFailures(client, HOST);
        await waitUntil(() => expect(read.calls).toBeGreaterThan(2));
        held.release();
        await Promise.all([first, second]);

        expect(read.calls).toBe(3);
        expect(read.state.data).toBe("recovered");
      },
    );

    it("leaves a refetch started elsewhere to finish, neither re-asking nor cancelling it", async () => {
      const client = freshClient();
      const read = await dataHoldingFailedRead(client, "a");
      const held = heldAnswer("from-retry");
      read.answer = held.answer;
      const retry = client.refetchQueries({ queryKey: read.queryKey });
      await waitUntil(() => expect(read.calls).toBe(3));

      const sweeping = sweepTransientCloudFailures(client, HOST);
      held.release();
      await Promise.all([retry, sweeping]);

      expect(read.calls).toBe(3);
      expect(read.state.status).toBe("success");
      expect(read.state.data).toBe("from-retry");
    });

    it("asks the read again on a later ring after its re-ask failed transiently", async () => {
      const client = freshClient();
      const read = await dataHoldingFailedRead(client, "a");
      read.answer = rejects(
        hostFailure("E_CLOUD_REQUEST_REFUSED", "bot.thread.list"),
      );
      await sweepTransientCloudFailures(client, HOST);
      expect(read.calls).toBe(3);
      expect(read.state.status).toBe("error");
      read.answer = resolves("later");

      await sweepTransientCloudFailures(client, HOST);

      expect(read.calls).toBe(4);
      expect(read.state.data).toBe("later");
    });

    it("lets a later ring re-ask a read whose own re-ask has settled while another read's is still pending", async () => {
      const client = freshClient();
      const settledAgain = await dataHoldingFailedRead(client, "a");
      const pending = await dataHoldingFailedRead(client, "b");
      const held = heldAnswer("b-recovered");
      settledAgain.answer = rejects(
        hostFailure("E_CLOUD_REQUEST_REFUSED", "bot.thread.list"),
      );
      pending.answer = held.answer;

      const first = sweepTransientCloudFailures(client, HOST);
      await waitUntil(() => {
        expect(settledAgain.calls).toBe(3);
        expect(settledAgain.state.fetchStatus).toBe("idle");
        expect(pending.calls).toBe(3);
      });
      expect(settledAgain.state.status).toBe("error");
      settledAgain.answer = resolves("a-recovered");

      const second = sweepTransientCloudFailures(client, HOST);
      await waitUntil(() => expect(settledAgain.calls).toBe(4));
      held.release();
      await Promise.all([first, second]);

      expect(settledAgain.calls).toBe(4);
      expect(settledAgain.state.data).toBe("a-recovered");
      expect(pending.calls).toBe(3);
      expect(pending.state.data).toBe("b-recovered");
    });

    it("does the same for reads that hold no data", async () => {
      const client = freshClient();
      const settledAgain = await failedRead(client, {
        hostId: HOST,
        method: "bot.list",
        name: "a",
        code: "E_CLOUD_REQUEST_REFUSED",
      });
      const pending = await failedRead(client, {
        hostId: HOST,
        method: "bot.list",
        name: "b",
        code: "E_CLOUD_REQUEST_REFUSED",
      });
      const held = heldAnswer("b-recovered");
      settledAgain.answer = rejects(
        hostFailure("E_CLOUD_REQUEST_REFUSED", "bot.list"),
      );
      pending.answer = held.answer;

      const first = sweepTransientCloudFailures(client, HOST);
      await waitUntil(() => {
        expect(settledAgain.calls).toBe(2);
        expect(settledAgain.state.fetchStatus).toBe("idle");
        expect(pending.calls).toBe(2);
      });
      settledAgain.answer = resolves("a-recovered");

      const second = sweepTransientCloudFailures(client, HOST);
      await waitUntil(() => expect(settledAgain.calls).toBe(3));
      held.release();
      await Promise.all([first, second]);

      expect(settledAgain.calls).toBe(3);
      expect(settledAgain.state.data).toBe("a-recovered");
      expect(pending.calls).toBe(2);
      expect(pending.state.data).toBe("b-recovered");
    });
  });

  describe.each(STRANDED_READS)(
    "a ring that meets an attempt in flight, read $label",
    (variant) => {
      const { method, base, strand } = variant;
      const refused = (): Error =>
        hostFailure("E_CLOUD_REQUEST_REFUSED", method);

      /** A sweep's own re-ask of the stranded read, held, once it has started asking. */
      async function ownReAsk(
        client: QueryClient,
        answer: () => Promise<string>,
      ): Promise<{ read: ScriptedRead; first: Promise<void> }> {
        const read = await strand(client);
        read.answer = answer;
        const first = sweepTransientCloudFailures(client, HOST);
        await waitUntil(() => expect(read.calls).toBe(base + 1));
        return { read, first };
      }

      it.each([1, 3])(
        "asks once more, and then no more, when %i ring(s) arrive during the sweep's own re-ask and it fails transiently",
        async (rings) => {
          const client = freshClient();
          const attempt = heldFailure(refused());
          const { read, first } = await ownReAsk(client, attempt.answer);

          const later = Array.from({ length: rings }, () =>
            sweepTransientCloudFailures(client, HOST),
          );
          expect(read.calls).toBe(base + 1);
          read.answer = rejects(refused());
          attempt.release();
          await Promise.all([first, ...later]);
          await quiet(client);

          expect(read.calls).toBe(base + 2);
          expect(read.state.status).toBe("error");
        },
      );

      it("asks once more after a refetch started elsewhere fails transiently, without cancelling it", async () => {
        const client = freshClient();
        const read = await strand(client);
        const attempt = heldFailure(refused());
        read.answer = attempt.answer;
        const retry = client.refetchQueries({ queryKey: read.queryKey });
        await waitUntil(() => expect(read.calls).toBe(base + 1));

        const ring = sweepTransientCloudFailures(client, HOST);
        expect(read.calls).toBe(base + 1);
        read.answer = rejects(refused());
        attempt.release();
        await Promise.all([retry, ring]);
        await quiet(client);

        expect(read.calls).toBe(base + 2);
        expect(read.state.status).toBe("error");
      });

      it.each([0, 2])(
        "owes nothing to a ring that arrives %i microtask turns after a sweep chose the read, before its ask started",
        async (turns) => {
          const client = freshClient();
          const read = await strand(client);
          const attempt = heldFailure(refused());
          read.answer = attempt.answer;

          const first = sweepTransientCloudFailures(client, HOST);
          for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
          const ring = sweepTransientCloudFailures(client, HOST);
          await waitUntil(() => expect(read.calls).toBe(base + 1));
          attempt.release();
          await Promise.all([first, ring]);
          await quiet(client);

          expect(read.calls).toBe(base + 1);
          expect(read.state.status).toBe("error");
        },
      );

      it("spends the ring owed to a replacement attempt, not the one the replaced attempt's end settles", async () => {
        const client = freshClient();
        const read = await strand(client);
        const x = heldFailure(refused());
        const y = heldFailure(refused());
        read.answer = x.answer;
        const elsewhere = client.refetchQueries({
          queryKey: read.queryKey,
          exact: true,
        });
        await waitUntil(() => expect(read.calls).toBe(base + 1));
        const firstRing = sweepTransientCloudFailures(client, HOST);

        // A read holding data restarts on a refetch, so the second ring meets
        // the new attempt; a read holding none joins the one in flight.
        const replaced = variant.data !== undefined;
        read.answer = y.answer;
        let secondRing: Promise<void> = Promise.resolve();
        queueMicrotask(() => {
          secondRing = sweepTransientCloudFailures(client, HOST);
        });
        const restart = client.refetchQueries({
          queryKey: read.queryKey,
          exact: true,
        });
        await waitUntil(() =>
          expect(read.calls).toBe(replaced ? base + 2 : base + 1),
        );
        await turn();
        read.answer = resolves("recovered");
        x.release();
        y.release();
        await Promise.all([elsewhere, restart, firstRing]);
        await secondRing;
        await quiet(client);

        expect(read.calls).toBe(replaced ? base + 3 : base + 2);
        expect(read.state.data).toBe("recovered");
      });

      it("asks no more when the attempt it met succeeds", async () => {
        const client = freshClient();
        const attempt = heldAnswer("recovered");
        const { read, first } = await ownReAsk(client, attempt.answer);

        const ring = sweepTransientCloudFailures(client, HOST);
        attempt.release();
        await Promise.all([first, ring]);
        await quiet(client);

        expect(read.calls).toBe(base + 1);
        expect(read.state.data).toBe("recovered");
      });

      it.each(["FORBIDDEN", "RPC_ERROR"] as const)(
        "asks no more when the attempt it met fails with %s",
        async (code) => {
          const client = freshClient();
          const attempt = heldFailure(hostFailure(code, method));
          const { read, first } = await ownReAsk(client, attempt.answer);

          const ring = sweepTransientCloudFailures(client, HOST);
          attempt.release();
          await Promise.all([first, ring]);
          await quiet(client);

          expect(read.calls).toBe(base + 1);
          expect(read.state.status).toBe("error");
        },
      );

      it("asks no more when no ring met the attempt and it fails transiently", async () => {
        const client = freshClient();
        const attempt = heldFailure(refused());
        const { read, first } = await ownReAsk(client, attempt.answer);

        attempt.release();
        await first;
        await quiet(client);

        expect(read.calls).toBe(base + 1);
        expect(read.state.status).toBe("error");
      });

      it("asks nothing when the read is removed before the attempt it met ends", async () => {
        const client = freshClient();
        const read = await strand(client);
        const attempt = heldFailure(refused());
        read.answer = attempt.answer;
        const first = sweepTransientCloudFailures(client, HOST);
        await waitUntil(() => expect(read.calls).toBe(base + 1));
        const ring = sweepTransientCloudFailures(client, HOST);

        read.release();
        client.removeQueries({ queryKey: read.queryKey });
        attempt.release();
        await Promise.all([first, ring]);
        await quiet(client);

        expect(read.calls).toBe(base + 1);
        expect(client.getQueryCache().find({ queryKey: read.queryKey })).toBe(
          undefined,
        );
      });
    },
  );
});
