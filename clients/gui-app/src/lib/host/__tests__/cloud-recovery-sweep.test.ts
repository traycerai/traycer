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
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";

const HOST = "host-A";
const OTHER_HOST = "host-B";

const clients: QueryClient[] = [];
function freshClient(): QueryClient {
  const client = createAppQueryClient();
  clients.push(client);
  return client;
}

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

async function settled(client: QueryClient): Promise<void> {
  await vi.waitFor(() => expect(client.isFetching()).toBe(0));
}

/** One macrotask turn: what a settled attempt sets going has run. */
function turn(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Lets what a settled attempt sets going run, and the cache go quiet. */
async function quiet(client: QueryClient): Promise<void> {
  await settled(client);
  await turn();
  await settled(client);
}

/** A read of `method` that has failed with `code`, still observed. */
async function failedRead(
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
  await vi.waitFor(() => expect(read.state.status).toBe("error"));
  return read;
}

/**
 * A read that holds data ("first") and whose refetch then failed with
 * `E_CLOUD_REQUEST_REFUSED`: status `error` with data, asked twice so far.
 * TanStack keeps that status through a re-ask, which is what makes such a
 * read a candidate for a second sweep while the first one's ask is open.
 */
async function dataHoldingFailedRead(
  client: QueryClient,
  name: string,
): Promise<ScriptedRead> {
  const read = new ScriptedRead(
    client,
    hostReadKey(HOST, "bot.thread.list", name),
    resolves("first"),
  );
  await vi.waitFor(() => expect(read.state.data).toBe("first"));
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
const STRANDED_READS = [
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
    await vi.waitFor(() => expect(read.state.data).toBe("first"));
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
    await vi.waitFor(() => expect(fine.state.status).toBe("success"));
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
    await vi.waitFor(() => expect(epicTasks.state.status).toBe("error"));
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
    await vi.waitFor(() =>
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
      await vi.waitFor(() => expect(read.state.data).toBe("ok"));
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
    await vi.waitFor(() =>
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
      await vi.waitFor(() => expect(read.calls).toBeGreaterThan(2));
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
      await vi.waitFor(() => expect(read.calls).toBeGreaterThan(1));
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
      await vi.waitFor(() =>
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
        await vi.waitFor(() => expect(read.calls).toBeGreaterThan(2));
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
      await vi.waitFor(() => expect(read.calls).toBe(3));

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
      await vi.waitFor(() => {
        expect(settledAgain.calls).toBe(3);
        expect(settledAgain.state.fetchStatus).toBe("idle");
        expect(pending.calls).toBe(3);
      });
      expect(settledAgain.state.status).toBe("error");
      settledAgain.answer = resolves("a-recovered");

      const second = sweepTransientCloudFailures(client, HOST);
      await vi.waitFor(() => expect(settledAgain.calls).toBe(4));
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
      await vi.waitFor(() => {
        expect(settledAgain.calls).toBe(2);
        expect(settledAgain.state.fetchStatus).toBe("idle");
        expect(pending.calls).toBe(2);
      });
      settledAgain.answer = resolves("a-recovered");

      const second = sweepTransientCloudFailures(client, HOST);
      await vi.waitFor(() => expect(settledAgain.calls).toBe(3));
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
        await vi.waitFor(() => expect(read.calls).toBe(base + 1));
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
        await vi.waitFor(() => expect(read.calls).toBe(base + 1));

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
          await vi.waitFor(() => expect(read.calls).toBe(base + 1));
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
        await vi.waitFor(() => expect(read.calls).toBe(base + 1));
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
        await vi.waitFor(() =>
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
        await vi.waitFor(() => expect(read.calls).toBe(base + 1));
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

  describe.each(STRANDED_READS)(
    "a removed read's sweep continuation, read $label",
    ({ method, base, strand }) => {
      const refused = (): Error =>
        hostFailure("E_CLOUD_REQUEST_REFUSED", method);

      /** A read R whose sweep re-ask is held, with a second ring owed to it. */
      async function staleSweepOverRead(client: QueryClient): Promise<{
        old: ScriptedRead;
        oldAnswer: { readonly release: () => void };
        first: Promise<void>;
        second: Promise<void>;
      }> {
        const old = await strand(client);
        const oldAnswer = heldFailure(refused());
        old.answer = oldAnswer.answer;
        const first = sweepTransientCloudFailures(client, HOST);
        await vi.waitFor(() => expect(old.calls).toBe(base + 1));
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
        await vi.waitFor(() =>
          expect(replacement.state.data).toBe("recovered"),
        );
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
        await vi.waitFor(() => expect(replacement.calls).toBe(1));
        const ring = sweepTransientCloudFailures(client, HOST);
        expect(replacement.calls).toBe(1);
        replacement.answer = resolves("recovered");
        replacementAnswer.release();
        await ring;
        await vi.waitFor(() =>
          expect(replacement.state.data).toBe("recovered"),
        );
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
        const read = await strand(client);
        const attempt = heldFailure(refused());
        read.answer = attempt.answer;
        const retry = client.refetchQueries({ queryKey: read.queryKey });
        await vi.waitFor(() => expect(read.calls).toBe(base + 1));
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
        client.setQueryDefaults(hostReadKey(HOST, method, "o"), { gcTime: 0 });
        const read = await strand(client);
        // Removed from the cache while its reader still holds it.
        client.removeQueries({ queryKey: read.queryKey, exact: true });
        const replacementAnswer = heldFailure(refused());
        const replacement = new ScriptedRead(
          client,
          read.queryKey,
          replacementAnswer.answer,
        );
        await vi.waitFor(() => expect(replacement.calls).toBe(1));
        const ring = sweepTransientCloudFailures(client, HOST);

        // The old reader lets go: gc announces its removal though the
        // replacement now holds the slot.
        read.release();
        await turn();
        replacement.answer = resolves("recovered");
        replacementAnswer.release();
        await ring;
        await vi.waitFor(() =>
          expect(replacement.state.data).toBe("recovered"),
        );
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
        await vi.waitFor(() => expect(other.state.data).toBe("recovered"));
        await quiet(client);

        expect(other.calls).toBe(2);
      });
    },
  );

  describe.each(STRANDED_READS)(
    "a reset or clear of a read with a ring owed, read $label",
    ({ method, base, strand }) => {
      const refused = (): Error =>
        hostFailure("E_CLOUD_REQUEST_REFUSED", method);

      it("drops the ring remembered for a read that is reset, whose own refetch is its next attempt", async () => {
        const client = freshClient();
        const read = await strand(client);
        const attempt = heldFailure(refused());
        read.answer = attempt.answer;
        const retry = client.refetchQueries({ queryKey: read.queryKey });
        await vi.waitFor(() => expect(read.calls).toBe(base + 1));
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
        const read = await strand(client);
        const attempt = heldFailure(refused());
        read.answer = attempt.answer;
        const first = sweepTransientCloudFailures(client, HOST);
        await vi.waitFor(() => expect(read.calls).toBe(base + 1));
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
        const read = await strand(client);
        const attempt = heldFailure(refused());
        read.answer = attempt.answer;
        const first = sweepTransientCloudFailures(client, HOST);
        await vi.waitFor(() => expect(read.calls).toBe(base + 1));
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
        const read = await strand(client);
        const attempt = heldFailure(refused());
        read.answer = attempt.answer;
        const firstRefetch = client.refetchQueries({
          queryKey: read.queryKey,
          exact: true,
        });
        await vi.waitFor(() => expect(read.calls).toBe(base + 1));
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
        const read = await strand(client);
        const attempt = heldFailure(refused());
        read.answer = attempt.answer;
        const first = sweepTransientCloudFailures(client, HOST);
        await vi.waitFor(() => expect(read.calls).toBe(base + 1));
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
    ({ method, base, data, strand }) => {
      const refused = (): Error =>
        hostFailure("E_CLOUD_REQUEST_REFUSED", method);

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
          const read = await strand(client);
          const attempt = heldFailure(refused());
          read.answer = attempt.answer;
          const first = sweepTransientCloudFailures(client, HOST);
          await vi.waitFor(() => expect(read.calls).toBe(base + 1));
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
          const read = await strand(client);
          const attempt = heldFailure(refused());
          read.answer = attempt.answer;
          const refetch = client.refetchQueries({
            queryKey: read.queryKey,
            exact: true,
          });
          await vi.waitFor(() => expect(read.calls).toBe(base + 1));
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
});
