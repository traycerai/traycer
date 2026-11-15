import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { EnvironmentStatusResponseV13 } from "@traycer/protocol/host/environment-schemas";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import { useHostQuery } from "@/hooks/host/use-host-query";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  mountTeamPage,
  personalPoolSource,
  resetTeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";

// Personal's id is read from authn's environment list under the signed-in viewer.
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
  resetTeamPageHarness();
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
    let status: EnvironmentStatusResponseV13 = environmentStatusFixture({
      principal: { kind: "personal" },
      receivedRevision: 1,
      appliedRevision: 1,
    });
    let listAsked = 0;
    let mcpAsked = 0;
    let skillsAsked = 0;
    const handlers: MockHandlerMap<HostRpcRegistry> = {
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
        return {
          outcome: "listed" as const,
          revision: null,
          policyRevision: null,
          skills: [],
          deletedBundled: [],
        };
      },
    };
    const { client } = buildEnvironmentClient({ hostId: HOST_ID, handlers });
    // The environment list is the app's own read from authn; the harness
    // serves it from the same handler, so a read of it is counted there.
    const harness = mountTeamPage(personalPoolSource(), handlers);
    recordNegotiatedHostManifest(HOST_ID, {
      "environment.status": { major: 1, minor: 1 },
    });
    render(
      <harness.Wrapper>
        <PersonalReaders client={client} />
      </harness.Wrapper>,
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
    await harness.queryClient.invalidateQueries({
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
