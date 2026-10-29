/**
 * Details loads a removed secret through the real `loadSecretDetails`. The
 * list carries a host's failure (`failedAt`); the versions read (@1.1) does
 * not. The loader reads the list through the shared query cache so the page
 * and Details see one list: the structured removal, failure included, must
 * be in the cache under the list's method scope after the load, from one list
 * request and no more - and a list already in that cache never stands in for
 * the read, however fresh the client calls it.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  hostRpcServingTierHostId,
  readProcessHostRpcTierPlan,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  mountTeamPage,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import { loadSecretDetails } from "@/components/settings/details/secret-details-status";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import type { DetailsStatus } from "@/lib/settings-details-entry";

type SecretsList = ResponseOfMethod<
  HostRpcRegistry,
  "environment.secrets.list"
>;

const AT = Date.UTC(2026, 9, 20, 9, 30);
const ENVIRONMENT = "env-a";
const SECRET = "sec-1";

const REMOVED: SecretsList["removed"][number] = {
  id: SECRET,
  name: "STRIPE_KEY",
  removal: {
    outcome: "cleanup_requested",
    revokedAt: AT,
    destroyedAt: null,
    targets: [
      {
        target: "host",
        hostId: "host-a",
        hostName: "dev-box",
        state: "requested",
        at: AT,
        failedAt: AT,
      },
    ],
  },
};

const STATUS: DetailsStatus = {
  summary: "",
  currentVersion: null,
  changedBy: null,
  changedAt: null,
  reason: null,
  hosts: [],
};

/** The scope the page's own read of the list files its answer under. */
const listScope = (hostId: string | null): readonly unknown[] =>
  hostQueryKeys.methodScope(
    hostRpcServingTierHostId(
      "environment.secrets.list",
      hostId,
      readProcessHostRpcTierPlan(),
      null,
    ),
    "environment.secrets.list",
  );

const listKey = (hostId: string | null): readonly unknown[] => [
  ...listScope(hostId),
  { environmentId: ENVIRONMENT },
];

const mountDetails = (): TeamPageHarness =>
  mountTeamPage(poolSource("editor"), {
    "environment.list": () => ({ environments: [] }),
    "environment.secrets.list": () => ({ secrets: [], removed: [REMOVED] }),
    // The versions read (@1.1) carries no host failure.
    "environment.secrets.versions": () => ({
      versions: [],
      removal: {
        ...REMOVED.removal,
        targets: REMOVED.removal.targets.map((target) => ({
          target: target.target,
          hostId: target.hostId,
          hostName: target.hostName,
          state: target.state,
          at: target.at,
        })),
      },
    }),
  });

afterEach(() => {
  resetTeamPageHarness();
});

describe("loadSecretDetails for a removed secret whose host failed", () => {
  it("keeps the failure line and leaves the list, failure included, in the shared cache after one list request", async () => {
    const harness = mountDetails();
    // The harness collects an unobserved query at once; the cache is read
    // after the load, so keep what the load put there.
    harness.queryClient.setDefaultOptions({
      queries: { retry: false, gcTime: Infinity },
    });
    const client = requireTeamHostClient();
    const hostId = client.getActiveHostId();

    const loaded = await loadSecretDetails(
      { environmentId: ENVIRONMENT, kind: "secret", key: SECRET },
      { hostId, client, queryClient: harness.queryClient },
      STATUS,
    );

    expect(loaded.status.summary).toContain("dev-box couldn't delete its copy");
    const cachedRemoved = harness.queryClient
      .getQueriesData<SecretsList>({ queryKey: listScope(hostId) })
      .flatMap(([, list]) => list?.removed ?? []);
    expect(cachedRemoved).toEqual([REMOVED]);
    expect(harness.paramsOf("environment.secrets.list")).toEqual([
      { environmentId: ENVIRONMENT },
    ]);
    expect(harness.paramsOf("environment.secrets.versions")).toHaveLength(1);
  });

  it("asks the host for the list even when the cache holds one the client calls fresh", async () => {
    const harness = mountDetails();
    // The app's own client holds a read fresh for a minute
    // (`createAppQueryClient`). Details authorizes its read on every open, so
    // a cache hit must not stand in for it.
    harness.queryClient.setDefaultOptions({
      queries: { retry: false, gcTime: Infinity, staleTime: 60_000 },
    });
    const client = requireTeamHostClient();
    const hostId = client.getActiveHostId();
    harness.queryClient.setQueryData<SecretsList>(listKey(hostId), {
      secrets: [],
      removed: [],
    });

    const loaded = await loadSecretDetails(
      { environmentId: ENVIRONMENT, kind: "secret", key: SECRET },
      { hostId, client, queryClient: harness.queryClient },
      STATUS,
    );

    expect(harness.paramsOf("environment.secrets.list")).toEqual([
      { environmentId: ENVIRONMENT },
    ]);
    expect(loaded.status.summary).toContain("dev-box couldn't delete its copy");
  });
});
