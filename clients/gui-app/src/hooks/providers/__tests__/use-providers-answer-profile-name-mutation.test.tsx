import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import {
  provider,
  profile,
} from "@/components/settings/panels/permissions/__tests__/judge-test-support";
import { useProvidersAnswerProfileNameForClient } from "@/hooks/providers/use-providers-answer-profile-name-mutation";
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";

const HOST_ID = "answer-profile-name-preservation";

type ProvidersList = ResponseOfMethod<HostRpcRegistry, "providers.list">;
type ExtendedProvidersList = ProvidersList & { readonly futureKey: string };

function listAnswer(): ExtendedProvidersList {
  const row: ProviderProfile = {
    ...profile("work", "managed"),
    label: "Work",
    aliases: ["legacy-work"],
    otherNames: ["Claude account"],
    personNotice: "waiting",
  };
  return {
    providers: [provider("claude-code", [row])],
    native: null,
    offersSignIns: true,
    removedProfiles: [
      {
        providerId: "claude-code",
        profileId: "removed-work",
        aliases: ["old-work"],
      },
    ],
    futureKey: "kept",
  };
}

function wrapper(queryClient: QueryClient) {
  return (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

describe("useProvidersAnswerProfileNameForClient", () => {
  afterEach(() => cleanup());

  it("preserves unowned envelope and projection fields while it settles the row name", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const { client, messenger } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "providers.answerProfileName": (request) => ({ label: request.label }),
      },
    });
    const listKey = hostQueryKeys.method<HostRpcRegistry, "providers.list">(
      HOST_ID,
      "providers.list",
      { native: null },
    );
    const seed = listAnswer();
    queryClient.setQueryData(listKey, seed);
    const mutation = renderHook(
      () => useProvidersAnswerProfileNameForClient(client),
      { wrapper: wrapper(queryClient) },
    );

    await act(async () => {
      await mutation.result.current.mutateAsync({
        providerId: "claude-code",
        profileId: "work",
        label: "Desk",
      });
    });

    const cached = queryClient.getQueryData<ExtendedProvidersList>(listKey);
    expect(cached).toEqual({
      ...seed,
      providers: seed.providers.map((providerState) => ({
        ...providerState,
        profiles: providerState.profiles.map((candidate) =>
          candidate.profileId === "work"
            ? { ...candidate, label: "Desk", otherNames: [] }
            : candidate,
        ),
      })),
    });
    expect(cached?.offersSignIns).toBe(true);
    expect(cached?.removedProfiles).toEqual(seed.removedProfiles);
    expect(cached?.futureKey).toBe("kept");
    expect(cached?.providers[0]?.profiles[0]).toMatchObject({
      aliases: ["legacy-work"],
      personNotice: "waiting",
      otherNames: [],
    });
    expect(messenger.calls.map((call) => call.method)).toEqual([
      "providers.answerProfileName",
    ]);
  });
});
