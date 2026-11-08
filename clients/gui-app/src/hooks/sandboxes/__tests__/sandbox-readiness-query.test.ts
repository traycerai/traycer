import { createAppQueryClient } from "@/lib/query-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryObserver } from "@tanstack/react-query";
import { AuthService } from "@/lib/auth/auth-service";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";
import { sandboxCatalogueQueryOptions } from "@/hooks/sandboxes/use-sandbox-catalogue-query";
import { budgetCatalogue } from "@/lib/sandboxes/__tests__/sandbox-catalogue-fixture";

const CONTEXT = {
  environmentId: null,
  os: "linux" as const,
  cpus: 2,
  memoryMb: 4096,
  diskMb: null,
  region: "us-east",
};
function harness() {
  const auth = new AuthService({ runnerHost: createFakeRunnerHost({}) });
  const read = vi
    .spyOn(auth, "getSandboxCatalogue")
    .mockResolvedValue({ kind: "ok", catalogue: budgetCatalogue(480_000) });
  const client = createAppQueryClient();
  return { auth, read, client };
}
afterEach(() => vi.useRealTimers());

describe("contextual catalogue query", () => {
  it("keeps environment and shape inventory in separate cache entries", async () => {
    const { auth, read, client } = harness();
    const contexts = [
      CONTEXT,
      { ...CONTEXT, environmentId: "env-other" },
      { ...CONTEXT, cpus: 4, memoryMb: 8192, diskMb: 40960 },
    ];
    for (const context of contexts)
      await client.fetchQuery(
        sandboxCatalogueQueryOptions(auth, null, true, context),
      );
    expect(client.getQueryCache().getAll()).toHaveLength(3);
    expect(read.mock.calls).toEqual(contexts.map((context) => [context]));
    client.clear();
  });

  it("refreshes each open and does not poll the inventory", async () => {
    vi.useFakeTimers();
    const { auth, read, client } = harness();
    const options = sandboxCatalogueQueryOptions(auth, null, true, CONTEXT);
    await client.fetchQuery(options);
    const first = new QueryObserver(client, options);
    const closeFirst = first.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    closeFirst();
    const second = new QueryObserver(client, options);
    const closeSecond = second.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(3);
    closeSecond();
    client.clear();
  });

  it("reads inventory again on the create preflight even while its old result is cached", async () => {
    const { auth, read, client } = harness();
    const options = sandboxCatalogueQueryOptions(auth, null, true, CONTEXT);
    await client.fetchQuery(options);
    read.mockResolvedValue({ kind: "ok", catalogue: budgetCatalogue(600_000) });
    expect(await client.fetchQuery(options)).toEqual(budgetCatalogue(600_000));
    client.clear();
  });
});
