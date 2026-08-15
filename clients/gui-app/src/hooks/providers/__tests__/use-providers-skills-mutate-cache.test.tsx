import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  ProviderSkill,
  ProvidersSkillsMutateAction,
} from "@traycer/protocol/host/provider-native-schemas";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { useProvidersSkillsList } from "@/hooks/providers/use-providers-skills-list-query";
import { useProvidersSkillsMutate } from "@/hooks/providers/use-providers-skills-mutate-mutation";
import { providersNativeQueryKeys } from "@/lib/query-keys/providers-native-query-keys";

vi.mock("@/lib/host", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/host")>("@/lib/host");
  return {
    ...actual,
    useHostClient: () => mockClientHolder.client,
  };
});

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: (client: HostClient<HostRpcRegistry> | null) => ({
    hostId: client?.getActiveHostId() ?? null,
    isReady: client !== null && client.getActiveHostId() !== null,
  }),
}));

vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: vi.fn(),
}));

const mockClientHolder: {
  client: HostClient<HostRpcRegistry> | null;
} = { client: null };

const EXISTING: ProviderSkill = {
  name: "find-skills",
  description: "Discover skills.",
  path: "/Users/dev/.agents/skills/find-skills",
  source: "shared",
};

const CREATED: ProviderSkill = {
  name: "review-pr",
  description: "Reviews a PR.",
  path: "/Users/dev/.agents/skills/review-pr",
  source: "shared",
};

function createFixture(handlers: {
  list: (
    params: RequestOfMethod<HostRpcRegistry, "providers.list">,
  ) =>
    | ResponseOfMethod<HostRpcRegistry, "providers.list">
    | Promise<ResponseOfMethod<HostRpcRegistry, "providers.list">>;
  nativeMutate: (
    params: RequestOfMethod<HostRpcRegistry, "providers.nativeMutate">,
  ) =>
    | ResponseOfMethod<HostRpcRegistry, "providers.nativeMutate">
    | Promise<ResponseOfMethod<HostRpcRegistry, "providers.nativeMutate">>;
}) {
  const queryClient = createAppQueryClient();
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "providers.list": (params) => handlers.list(params),
        "providers.nativeMutate": (params) => handlers.nativeMutate(params),
      },
    }),
  });
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  mockClientHolder.client = client;

  function Wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  }

  return {
    queryClient,
    Wrapper,
    hostId: mockLocalHostEntry.hostId,
  };
}

afterEach(() => {
  cleanup();
  mockClientHolder.client = null;
});

type SkillsListInvalidatePredicate = (query: {
  readonly queryKey: readonly unknown[];
}) => boolean;

function isSkillsListInvalidatePredicate(
  value: unknown,
): value is SkillsListInvalidatePredicate {
  return typeof value === "function";
}

function invalidatePredicate(spy: {
  readonly mock: {
    readonly calls: ReadonlyArray<readonly unknown[]>;
  };
}): SkillsListInvalidatePredicate | null {
  for (const [filters] of spy.mock.calls) {
    const predicate =
      typeof filters === "object" && filters !== null && "predicate" in filters
        ? filters.predicate
        : undefined;
    if (isSkillsListInvalidatePredicate(predicate)) {
      return predicate;
    }
  }
  return null;
}

const WRITE_FAILURES: readonly ProvidersSkillsMutateAction[] = [
  {
    action: "add",
    sourcePath: "/tmp/review-pr",
    providerScoped: false,
  },
  {
    action: "create",
    name: "review-pr",
    description: "Reviews a PR.",
    body: "## Steps\n",
    providerScoped: false,
  },
  {
    action: "edit",
    path: EXISTING.path,
    expectedHash: "a".repeat(64),
    name: EXISTING.name,
    description: EXISTING.description ?? "",
    body: "# Body\n",
  },
  {
    action: "update",
    name: EXISTING.name,
    path: EXISTING.path,
  },
  {
    action: "remove",
    name: EXISTING.name,
    path: EXISTING.path,
  },
];

describe("useProvidersSkillsMutate cache", () => {
  it("does not write the list cache on inspect, then writes it on a skills mutation", async () => {
    let listedSkills: ProviderSkill[] = [EXISTING];
    const fixture = createFixture({
      list: () => ({
        providers: [],
        native: { ok: true, kind: "skills", skills: listedSkills },
      }),
      nativeMutate: (params) => {
        if (
          params.mutation.kind === "skills" &&
          params.mutation.mutation.action === "inspect"
        ) {
          return {
            result: {
              ok: true,
              kind: "skillsInspect",
              token: "tok-inspect",
              commitSha: "deadbeef",
              candidates: [
                {
                  name: "show-me",
                  description: null,
                  relPath: "show-me/SKILL.md",
                  installed: false,
                },
              ],
            },
          };
        }
        listedSkills = [CREATED];
        return {
          result: { ok: true, kind: "skills", skills: [CREATED] },
        };
      },
    });

    const listRendered = renderHook(
      () =>
        useProvidersSkillsList({
          providerId: "codex",
          scope: "global",
          workspaceRoot: null,
          enabled: true,
        }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(listRendered.result.current.data?.skills).toEqual([EXISTING]);
    });

    const mutateRendered = renderHook(() => useProvidersSkillsMutate(), {
      wrapper: fixture.Wrapper,
    });

    let inspectResult: unknown;
    await act(async () => {
      inspectResult = await mutateRendered.result.current.mutateAsync({
        providerId: "codex",
        scope: "global",
        workspaceRoot: null,
        mutation: {
          action: "inspect",
          source: "owner/repo",
          scope: "global",
        },
        suppressToast: true,
      });
    });

    expect(inspectResult).toMatchObject({
      kind: "inspect",
      token: "tok-inspect",
    });
    const listKey = providersNativeQueryKeys.skillsList(fixture.hostId, {
      providerId: "codex",
      scope: "global",
      workspaceRoot: null,
    });
    expect(fixture.queryClient.getQueryData(listKey)).toEqual({
      skills: [EXISTING],
    });

    await act(async () => {
      await mutateRendered.result.current.mutateAsync({
        providerId: "codex",
        scope: "global",
        workspaceRoot: null,
        mutation: {
          action: "create",
          name: "review-pr",
          description: "Reviews a PR.",
          body: "## Steps\n",
          providerScoped: false,
        },
        suppressToast: true,
      });
    });

    await waitFor(() => {
      expect(fixture.queryClient.getQueryData(listKey)).toEqual({
        skills: [CREATED],
      });
    });
  });

  it("invalidates the skills list when a multi-name import throws after rows may have landed", async () => {
    let listCalls = 0;
    const fixture = createFixture({
      list: () => {
        listCalls += 1;
        return {
          providers: [],
          native: { ok: true, kind: "skills", skills: [EXISTING] },
        };
      },
      nativeMutate: () => ({
        result: {
          ok: false,
          code: "external_drift",
          detail: "Imported show-me, then the source moved",
        },
      }),
    });

    const listRendered = renderHook(
      () =>
        useProvidersSkillsList({
          providerId: "codex",
          scope: "global",
          workspaceRoot: null,
          enabled: true,
        }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(listRendered.result.current.data?.skills).toEqual([EXISTING]);
    });
    const listCallsAfterSeed = listCalls;
    const listKey = providersNativeQueryKeys.skillsList(fixture.hostId, {
      providerId: "codex",
      scope: "global",
      workspaceRoot: null,
    });
    expect(fixture.queryClient.getQueryData(listKey)).toEqual({
      skills: [EXISTING],
    });

    const invalidateSpy = vi.spyOn(fixture.queryClient, "invalidateQueries");
    const mutateRendered = renderHook(() => useProvidersSkillsMutate(), {
      wrapper: fixture.Wrapper,
    });

    let thrown: unknown;
    await act(async () => {
      try {
        await mutateRendered.result.current.mutateAsync({
          providerId: "codex",
          scope: "global",
          workspaceRoot: null,
          mutation: {
            action: "import",
            source: "owner/repo",
            providerScoped: false,
            token: "tok-partial",
            names: ["show-me", "design-control-loop"],
          },
          suppressToast: true,
        });
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeDefined();
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: listKey,
    });
    await waitFor(() => {
      expect(listCalls).toBeGreaterThan(listCallsAfterSeed);
    });
  });

  it("does not invalidate the skills list when inspect throws", async () => {
    let listCalls = 0;
    const fixture = createFixture({
      list: () => {
        listCalls += 1;
        return {
          providers: [],
          native: { ok: true, kind: "skills", skills: [EXISTING] },
        };
      },
      nativeMutate: () => ({
        result: {
          ok: false,
          code: "unsupported_action",
          detail: "inspect failed",
        },
      }),
    });

    const listRendered = renderHook(
      () =>
        useProvidersSkillsList({
          providerId: "codex",
          scope: "global",
          workspaceRoot: null,
          enabled: true,
        }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(listRendered.result.current.data?.skills).toEqual([EXISTING]);
    });
    const listCallsAfterSeed = listCalls;
    const listKey = providersNativeQueryKeys.skillsList(fixture.hostId, {
      providerId: "codex",
      scope: "global",
      workspaceRoot: null,
    });

    const invalidateSpy = vi.spyOn(fixture.queryClient, "invalidateQueries");
    const mutateRendered = renderHook(() => useProvidersSkillsMutate(), {
      wrapper: fixture.Wrapper,
    });

    let thrown: unknown;
    await act(async () => {
      try {
        await mutateRendered.result.current.mutateAsync({
          providerId: "codex",
          scope: "global",
          workspaceRoot: null,
          mutation: {
            action: "inspect",
            source: "owner/repo",
            scope: "global",
          },
          suppressToast: true,
        });
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeDefined();
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(listCalls).toBe(listCallsAfterSeed);
    expect(fixture.queryClient.getQueryData(listKey)).toEqual({
      skills: [EXISTING],
    });
  });

  it("invalidates every same-host skills list after a shared-scope write", async () => {
    let listedSkills: ProviderSkill[] = [EXISTING];
    const fixture = createFixture({
      list: () => ({
        providers: [],
        native: { ok: true, kind: "skills", skills: listedSkills },
      }),
      nativeMutate: () => {
        listedSkills = [CREATED];
        return {
          result: { ok: true, kind: "skills", skills: [CREATED] },
        };
      },
    });

    const scope = {
      scope: "global" as const,
      workspaceRoot: null,
    };
    const initiatingKey = providersNativeQueryKeys.skillsList(fixture.hostId, {
      providerId: "codex",
      ...scope,
    });
    const otherProviderKey = providersNativeQueryKeys.skillsList(
      fixture.hostId,
      { providerId: "claude-code", ...scope },
    );

    const initiatingList = renderHook(
      () =>
        useProvidersSkillsList({
          providerId: "codex",
          ...scope,
          enabled: true,
        }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(initiatingList.result.current.data?.skills).toEqual([EXISTING]);
    });
    fixture.queryClient.setQueryData(otherProviderKey, {
      skills: [EXISTING],
    });

    const invalidateSpy = vi.spyOn(fixture.queryClient, "invalidateQueries");
    const mutateRendered = renderHook(() => useProvidersSkillsMutate(), {
      wrapper: fixture.Wrapper,
    });

    await act(async () => {
      await mutateRendered.result.current.mutateAsync({
        providerId: "codex",
        ...scope,
        mutation: {
          action: "create",
          name: "review-pr",
          description: "Reviews a PR.",
          body: "## Steps\n",
          providerScoped: false,
        },
        suppressToast: true,
      });
    });

    const predicate = invalidatePredicate(invalidateSpy);
    expect(predicate).not.toBeNull();
    if (predicate === null) {
      throw new Error("expected a skills-list invalidate predicate");
    }
    expect(predicate({ queryKey: initiatingKey })).toBe(true);
    expect(predicate({ queryKey: otherProviderKey })).toBe(true);

    await waitFor(() => {
      expect(fixture.queryClient.getQueryData(initiatingKey)).toEqual({
        skills: [CREATED],
      });
    });
  });

  it("keeps a direct cache write for a provider-scoped success", async () => {
    const fixture = createFixture({
      list: () => ({
        providers: [],
        native: { ok: true, kind: "skills", skills: [EXISTING] },
      }),
      nativeMutate: () => ({
        result: { ok: true, kind: "skills", skills: [CREATED] },
      }),
    });

    const scope = {
      scope: "global" as const,
      workspaceRoot: null,
    };
    const initiatingKey = providersNativeQueryKeys.skillsList(fixture.hostId, {
      providerId: "codex",
      ...scope,
    });
    const otherProviderKey = providersNativeQueryKeys.skillsList(
      fixture.hostId,
      { providerId: "claude-code", ...scope },
    );

    const initiatingList = renderHook(
      () =>
        useProvidersSkillsList({
          providerId: "codex",
          ...scope,
          enabled: true,
        }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(initiatingList.result.current.data?.skills).toEqual([EXISTING]);
    });
    fixture.queryClient.setQueryData(otherProviderKey, {
      skills: [EXISTING],
    });

    const invalidateSpy = vi.spyOn(fixture.queryClient, "invalidateQueries");
    const mutateRendered = renderHook(() => useProvidersSkillsMutate(), {
      wrapper: fixture.Wrapper,
    });

    await act(async () => {
      await mutateRendered.result.current.mutateAsync({
        providerId: "codex",
        ...scope,
        mutation: {
          action: "create",
          name: "review-pr",
          description: "Reviews a PR.",
          body: "## Steps\n",
          providerScoped: true,
        },
        suppressToast: true,
      });
    });

    expect(invalidatePredicate(invalidateSpy)).toBeNull();
    expect(fixture.queryClient.getQueryData(initiatingKey)).toEqual({
      skills: [CREATED],
    });
    expect(fixture.queryClient.getQueryData(otherProviderKey)).toEqual({
      skills: [EXISTING],
    });
  });

  it("invalidates the initiating skills list when any write action throws", async () => {
    const fixture = createFixture({
      list: () => ({
        providers: [],
        native: { ok: true, kind: "skills", skills: [EXISTING] },
      }),
      nativeMutate: () => ({
        result: {
          ok: false,
          code: "external_drift",
          detail: "write landed then failed",
        },
      }),
    });

    const listRendered = renderHook(
      () =>
        useProvidersSkillsList({
          providerId: "codex",
          scope: "global",
          workspaceRoot: null,
          enabled: true,
        }),
      { wrapper: fixture.Wrapper },
    );
    await waitFor(() => {
      expect(listRendered.result.current.data?.skills).toEqual([EXISTING]);
    });
    const listKey = providersNativeQueryKeys.skillsList(fixture.hostId, {
      providerId: "codex",
      scope: "global",
      workspaceRoot: null,
    });
    const invalidateSpy = vi.spyOn(fixture.queryClient, "invalidateQueries");
    const mutateRendered = renderHook(() => useProvidersSkillsMutate(), {
      wrapper: fixture.Wrapper,
    });

    for (const mutation of WRITE_FAILURES) {
      invalidateSpy.mockClear();
      let thrown: unknown;
      await act(async () => {
        try {
          await mutateRendered.result.current.mutateAsync({
            providerId: "codex",
            scope: "global",
            workspaceRoot: null,
            mutation,
            suppressToast: true,
          });
        } catch (error) {
          thrown = error;
        }
      });
      expect(thrown).toBeDefined();
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: listKey,
      });
    }
  });
});
