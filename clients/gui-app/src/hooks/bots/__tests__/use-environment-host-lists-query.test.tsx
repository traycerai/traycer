/**
 * The machine lists of several team environments, each the app's own read of
 * authn on the person's sign-in (Tracy Bots):
 * an environment whose list was refused is named failed and stays out of the
 * answered map (so a reader can tell "could not read" from "no machine"), and
 * `retryFailed` asks the failed ones again without re-asking the answered.
 *
 * Real hook over the page harness's fake authn, whose handler can refuse.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { EnvironmentHostRecordV12 } from "@traycer/protocol/host/environment/contracts";
import { hostQueryKeys } from "@/lib/query-keys/host-query-keys";
import {
  mountTeamPage,
  personalPoolSource,
  resetTeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import {
  useEnvironmentHostLists,
  type EnvironmentHostLists,
} from "@/hooks/bots/use-environment-host-lists-query";
import { useAuthStore } from "@/stores/auth/auth-store";

// The lists are the signed-in viewer's, and are not read without one.
beforeEach(() => {
  useAuthStore.setState({
    status: "signed-in",
    contextMetadata: { userId: "user-1", username: "Ada" },
  });
});
afterEach(() => {
  resetTeamPageHarness();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

const FLAKY = "env-flaky";
const STEADY = "env-steady";

function machine(hostId: string): EnvironmentHostRecordV12 {
  return {
    hostId,
    hostLabel: hostId,
    hostPlatform: null,
    enrolledByUserId: "user-1",
    kind: "sandbox",
    boundAt: 1,
    reachable: true,
    lastReportedAt: null,
    hasLocalRow: false,
    applied: [],
  };
}

function mountLists(flakyAnswersFromStart: boolean): {
  readonly lists: () => EnvironmentHostLists;
  readonly reads: () => Readonly<Record<string, number>>;
  readonly healFlaky: () => void;
  readonly breakFlaky: () => void;
  readonly refetchFlaky: () => Promise<void>;
} {
  const reads: Record<string, number> = {};
  let flakyAnswers = flakyAnswersFromStart;
  const harness = mountTeamPage(personalPoolSource(), {
    "environment.host.list": ({ environmentId }) => {
      reads[environmentId] = (reads[environmentId] ?? 0) + 1;
      if (environmentId === FLAKY && !flakyAnswers) {
        throw new Error("refused");
      }
      return { hosts: [machine(`host-in-${environmentId}`)] };
    },
  });
  const queryClient = harness.queryClient;
  const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <harness.Wrapper>{props.children}</harness.Wrapper>
  );
  const { result } = renderHook(
    () => useEnvironmentHostLists([FLAKY, STEADY], true),
    { wrapper },
  );
  return {
    lists: () => result.current,
    reads: () => ({ ...reads }),
    healFlaky: () => {
      flakyAnswers = true;
    },
    breakFlaky: () => {
      flakyAnswers = false;
    },
    // An invalidation-driven refetch of FLAKY's list only: the query keeps
    // its last answer in `data` while the refetch fails.
    refetchFlaky: () =>
      queryClient.invalidateQueries({
        predicate: ({ queryKey }) => {
          if (
            !hostQueryKeys.matchesMethodOnAnyHost(
              queryKey,
              "environment.host.list",
            )
          ) {
            return false;
          }
          const params = queryKey[3];
          return (
            typeof params === "object" &&
            params !== null &&
            "environmentId" in params &&
            params.environmentId === FLAKY
          );
        },
      }),
  };
}

describe("useEnvironmentHostLists", () => {
  it("names a refused environment failed and leaves it out of the answered map", async () => {
    const mounted = mountLists(false);

    await waitFor(() => {
      expect(mounted.lists().failedEnvironmentIds).toEqual(new Set([FLAKY]));
      expect(mounted.lists().hostsByEnvironmentId.has(STEADY)).toBe(true);
    });
    expect(mounted.lists().hostsByEnvironmentId.has(FLAKY)).toBe(false);
  });

  it("retries only the failed environments, and an answer clears the failure", async () => {
    const mounted = mountLists(false);
    await waitFor(() => {
      expect(mounted.lists().failedEnvironmentIds.has(FLAKY)).toBe(true);
    });
    expect(mounted.reads()).toEqual({ [FLAKY]: 1, [STEADY]: 1 });

    mounted.healFlaky();
    act(() => {
      mounted.lists().retryFailed();
    });

    await waitFor(() => {
      expect(
        mounted
          .lists()
          .hostsByEnvironmentId.get(FLAKY)
          ?.map((host) => host.hostId),
      ).toEqual([`host-in-${FLAKY}`]);
    });
    expect(mounted.lists().failedEnvironmentIds.size).toBe(0);
    expect(mounted.reads()).toEqual({ [FLAKY]: 2, [STEADY]: 1 });
  });

  it("treats a failed refetch of an answered list as failed, not as its stale answer", async () => {
    const mounted = mountLists(true);
    await waitFor(() => {
      expect([...mounted.lists().hostsByEnvironmentId.keys()].sort()).toEqual([
        FLAKY,
        STEADY,
      ]);
    });
    expect(mounted.lists().failedEnvironmentIds.size).toBe(0);
    expect(mounted.reads()).toEqual({ [FLAKY]: 1, [STEADY]: 1 });

    mounted.breakFlaky();
    await act(async () => {
      await mounted.refetchFlaky();
    });

    await waitFor(() => {
      expect(mounted.lists().failedEnvironmentIds).toEqual(new Set([FLAKY]));
    });
    expect(mounted.lists().hostsByEnvironmentId.has(FLAKY)).toBe(false);
    expect(mounted.lists().hostsByEnvironmentId.has(STEADY)).toBe(true);
    expect(mounted.reads()).toEqual({ [FLAKY]: 2, [STEADY]: 1 });

    mounted.healFlaky();
    act(() => {
      mounted.lists().retryFailed();
    });

    await waitFor(() => {
      expect(mounted.lists().hostsByEnvironmentId.has(FLAKY)).toBe(true);
    });
    expect(mounted.lists().failedEnvironmentIds.size).toBe(0);
    expect(mounted.lists().hostsByEnvironmentId.has(STEADY)).toBe(true);
    expect(mounted.reads()).toEqual({ [FLAKY]: 3, [STEADY]: 1 });
  });
});
