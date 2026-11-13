import { afterEach, describe, expect, it, vi } from "vitest";
import { MutationObserver, type QueryClient } from "@tanstack/react-query";
import { cloudQueryKeys } from "@/lib/query-keys/cloud-query-keys";
import { sweepTransientCloudFailures } from "@/lib/host/cloud-recovery-sweep";
import {
  ScriptedRead,
  heldAnswer,
  hostFailure,
  hostReadKey,
  rejects,
  resolves,
} from "@/lib/host/test-support/cloud-failure-reads";
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
});
