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
import type { ProviderSkill } from "@traycer/protocol/host/provider-native-schemas";
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

describe("useProvidersSkillsMutate cache", () => {
  it("does not write the list cache on inspect, then writes it on a skills mutation", async () => {
    const fixture = createFixture({
      list: () => ({
        providers: [],
        native: { ok: true, kind: "skills", skills: [EXISTING] },
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
});
