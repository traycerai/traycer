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

/**
 * One macrotask turn: the sweep's cancel-then-invalidate chain runs on
 * microtasks it does not hand back, so a check that no further ask follows
 * needs the turn that drains them.
 */
function drainSweepChains(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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

      sweepTransientCloudFailures(client, HOST);
      await vi.waitFor(() => expect(read.calls).toBe(2));
      await settled(client);

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

    sweepTransientCloudFailures(client, HOST);
    await vi.waitFor(() => expect(read.calls).toBe(3));
    await settled(client);

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

    sweepTransientCloudFailures(client, HOST);
    await vi.waitFor(() => expect(mine.calls).toBe(2));
    await settled(client);

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

      sweepTransientCloudFailures(client, HOST);
      await vi.waitFor(() => expect(transient.calls).toBe(2));
      await settled(client);

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

    sweepTransientCloudFailures(client, HOST);
    await vi.waitFor(() => expect(failed.calls).toBe(2));
    await settled(client);

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

    sweepTransientCloudFailures(client, HOST);
    await vi.waitFor(() => expect(failed.calls).toBe(2));

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

    sweepTransientCloudFailures(client, HOST);
    await vi.waitFor(() => expect(failed.calls).toBe(2));
    await settled(client);

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

    sweepTransientCloudFailures(client, HOST);
    await vi.waitFor(() => expect(active.calls).toBe(2));
    await settled(client);

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

    sweepTransientCloudFailures(client, HOST);
    await vi.waitFor(() => expect(read.calls).toBe(2));
    await settled(client);

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

    sweepTransientCloudFailures(client, HOST);
    await vi.waitFor(() =>
      expect(reads.map((read) => read.calls)).toEqual([2, 2, 2, 2, 2]),
    );
    sweepTransientCloudFailures(client, HOST);
    sweepTransientCloudFailures(client, HOST);
    await drainSweepChains();

    expect(reads.map((read) => read.calls)).toEqual([2, 2, 2, 2, 2]);
    held.release();
    await settled(client);
    await drainSweepChains();
    await settled(client);
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

    sweepTransientCloudFailures(client, HOST);
    await vi.waitFor(() =>
      expect(reads.map((read) => read.calls)).toEqual([3, 3, 3, 3, 3]),
    );
    sweepTransientCloudFailures(client, HOST);
    sweepTransientCloudFailures(client, HOST);
    await drainSweepChains();

    expect(reads.map((read) => read.calls)).toEqual([3, 3, 3, 3, 3]);
    held.release();
    await settled(client);
    await drainSweepChains();
    await settled(client);
    expect(reads.map((read) => read.calls)).toEqual([3, 3, 3, 3, 3]);
  });
});
