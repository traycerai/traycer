import {
  QueryClient,
  QueryObserver,
  type QueryKey,
} from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import {
  invalidateProviderFamilyQueries,
  providersListQueryKey,
} from "@/lib/query-keys/providers-query-keys";
import {
  providersNativeQueryKeys,
  type NativeListScopeParams,
} from "@/lib/query-keys/providers-native-query-keys";

const CODEX: NativeListScopeParams = {
  providerId: "codex",
  scope: "global",
  workspaceRoot: null,
};
const CLAUDE: NativeListScopeParams = {
  providerId: "claude-code",
  scope: "global",
  workspaceRoot: null,
};

interface Watched {
  /** One entry per read the query issued; calling it settles that read. */
  readonly reads: Array<() => void>;
  readonly key: QueryKey;
}

let queryClient: QueryClient;
const observers: Array<() => void> = [];

/** An observed query whose every read stays pending until the test settles it. */
function watch(key: QueryKey): Watched {
  const reads: Array<() => void> = [];
  const observer = new QueryObserver(queryClient, {
    queryKey: key,
    queryFn: () =>
      new Promise<object>((resolve) => {
        reads.push(() => {
          resolve({});
        });
      }),
    staleTime: Infinity,
    retry: false,
  });
  observers.push(observer.subscribe(() => undefined));
  return { reads, key };
}

/** A watched query whose first read has settled, so only later reads count. */
async function watchSettled(key: QueryKey): Promise<Watched> {
  const watched = watch(key);
  watched.reads[0]();
  await flush();
  return watched;
}

async function flush(): Promise<void> {
  for (let hop = 0; hop < 20; hop += 1) await Promise.resolve();
}

function refresh(providerIds: ReadonlyArray<string | null>): void {
  invalidateProviderFamilyQueries(
    queryClient,
    "h1",
    ["providers.list"],
    providerIds,
  );
}

afterEach(() => {
  for (const unsubscribe of observers.splice(0)) unsubscribe();
  queryClient.clear();
});

describe("invalidateProviderFamilyQueries", () => {
  it("answers a burst of same-tick events with one read", async () => {
    queryClient = new QueryClient();
    const skills = await watchSettled(
      providersNativeQueryKeys.skillsList("h1", CODEX),
    );

    refresh(["codex"]);
    refresh(["codex"]);
    refresh(["codex", "claude-code"]);
    await flush();

    expect(skills.reads).toHaveLength(2);
  });

  it("holds one successor for changes that land while a refresh is pending, and no more", async () => {
    queryClient = new QueryClient();
    const skills = await watchSettled(
      providersNativeQueryKeys.skillsList("h1", CODEX),
    );
    refresh(["codex"]);
    await flush();
    expect(skills.reads).toHaveLength(2);

    // Real changes during the pending refresh: neither cancels it nor starts a
    // read beside it.
    refresh(["codex"]);
    refresh(["codex"]);
    await flush();
    expect(skills.reads).toHaveLength(2);

    skills.reads[1]();
    await flush();
    expect(skills.reads).toHaveLength(3);

    skills.reads[2]();
    await flush();
    expect(skills.reads).toHaveLength(3);
  });

  it("leaves another host, another provider, another method and versioned artwork alone", async () => {
    queryClient = new QueryClient();
    const target = await watchSettled(
      providersNativeQueryKeys.skillsList("h1", CODEX),
    );
    const unversionedIcon = await watchSettled(
      providersNativeQueryKeys.pluginIcon("h1", {
        ...CODEX,
        pluginId: "pdf@m",
        theme: "light",
        version: null,
      }),
    );
    const untouched = [
      await watchSettled(providersNativeQueryKeys.skillsList("h2", CODEX)),
      await watchSettled(providersNativeQueryKeys.skillsList("h1", CLAUDE)),
      await watchSettled(
        providersNativeQueryKeys.pluginIcon("h1", {
          ...CODEX,
          pluginId: "pdf@m",
          theme: "dark",
          version: "2",
        }),
      ),
      await watchSettled([...hostQueryKeys.scope("h1"), "epic.list", {}]),
    ];

    refresh(["codex"]);
    await flush();

    expect(target.reads).toHaveLength(2);
    expect(unversionedIcon.reads).toHaveLength(2);
    for (const other of untouched) {
      expect(other.reads).toHaveLength(1);
      expect(queryClient.getQueryState(other.key)?.isInvalidated).toBe(false);
    }
  });

  it("refreshes every mutable provider query for an event that names no provider", async () => {
    queryClient = new QueryClient();
    const codex = await watchSettled(
      providersNativeQueryKeys.skillsList("h1", CODEX),
    );
    const claude = await watchSettled(
      providersNativeQueryKeys.skillsList("h1", CLAUDE),
    );

    refresh([null]);
    await flush();

    expect(codex.reads).toHaveLength(2);
    expect(claude.reads).toHaveLength(2);
  });

  it("refreshes only the host's classic list for a classic invalidation", async () => {
    queryClient = new QueryClient();
    const classic = await watchSettled(providersListQueryKey("h1"));
    const untouched = [
      await watchSettled(providersListQueryKey("h2")),
      await watchSettled(providersNativeQueryKeys.skillsList("h1", CODEX)),
    ];

    invalidateProviderFamilyQueries(
      queryClient,
      "h1",
      ["providers.list"],
      "classic",
    );
    await flush();

    expect(classic.reads).toHaveLength(2);
    for (const other of untouched) expect(other.reads).toHaveLength(1);
  });

  it("does not revive a query removed before the refresh ran", async () => {
    queryClient = new QueryClient();
    const skills = await watchSettled(
      providersNativeQueryKeys.skillsList("h1", CODEX),
    );

    refresh(["codex"]);
    queryClient.removeQueries();
    await flush();

    expect(skills.reads).toHaveLength(1);
  });
});
