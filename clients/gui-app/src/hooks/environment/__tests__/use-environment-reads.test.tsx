import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import { useHostQuery } from "@/hooks/host/use-host-query";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";

// Personal's id is read from `environment.list` under the signed-in viewer.
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));

const HOST_ID = "host-a";
const PERSONAL = { environmentId: "env-personal" } as const;

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
});

/** The Personal page's reader of the status, beside the cloud reads it shows. */
function PersonalReaders(props: {
  readonly client: HostClient<HostRpcRegistry>;
}): ReactNode {
  const status = useEnvironmentStatusRead(props.client, HOST_ID, true);
  useHostQuery<HostRpcRegistry, "environment.configuration.mcpServers.list">({
    cacheKeyIdentity: undefined,
    client: props.client,
    method: "environment.configuration.mcpServers.list",
    params: PERSONAL,
    options: {},
  });
  useHostQuery<HostRpcRegistry, "environment.configuration.skills.list">({
    cacheKeyIdentity: undefined,
    client: props.client,
    method: "environment.configuration.skills.list",
    params: PERSONAL,
    options: {},
  });
  return (
    <p data-testid="revision">{String(status.data?.receivedRevision ?? "")}</p>
  );
}

describe("a Personal revision change", () => {
  it("rereads the Personal MCP servers and Skills a change elsewhere moved", async () => {
    let status: EnvironmentStatusResponseV11 = environmentStatusFixture({
      principal: { kind: "personal" },
      receivedRevision: 1,
      appliedRevision: 1,
    });
    let listAsked = 0;
    let mcpAsked = 0;
    let skillsAsked = 0;
    const { client } = buildEnvironmentClient({
      hostId: HOST_ID,
      handlers: {
        "environment.status": () => status,
        "environment.list": () => {
          listAsked += 1;
          return {
            environments: [
              {
                environmentId: "env-personal",
                ownerKind: "user" as const,
                ownerId: "user-me",
                roomId: "room-personal",
                label: "Personal",
                effectiveRole: "owner" as const,
                kind: "personal" as const,
                hostCount: 1,
                providerHandle: null,
              },
            ],
          };
        },
        "environment.configuration.mcpServers.list": () => {
          mcpAsked += 1;
          return { servers: [] };
        },
        "environment.configuration.skills.list": () => {
          skillsAsked += 1;
          return { outcome: "listed" as const, revision: null, skills: [] };
        },
      },
    });
    recordNegotiatedHostManifest(HOST_ID, {
      "environment.status": { major: 1, minor: 1 },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <PersonalReaders client={client} />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("revision").textContent).toBe("1");
      expect(mcpAsked).toBe(1);
      expect(skillsAsked).toBe(1);
      // Personal's id has been read, so the next revision can name it.
      expect(listAsked).toBe(1);
    });

    // The host reports a newer revision on its next status poll.
    status = environmentStatusFixture({
      principal: { kind: "personal" },
      receivedRevision: 2,
      appliedRevision: 2,
    });
    await queryClient.invalidateQueries({
      queryKey: hostQueryKeys.methodScope(HOST_ID, "environment.status"),
    });

    await waitFor(() => {
      expect(screen.getByTestId("revision").textContent).toBe("2");
    });
    await waitFor(() => {
      expect(mcpAsked).toBe(2);
      expect(skillsAsked).toBe(2);
    });
  });
});
