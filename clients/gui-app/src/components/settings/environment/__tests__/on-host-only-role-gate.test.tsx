import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConfigurationSourceContext,
  type ConfigurationRole,
  type ConfigurationSource,
} from "@/components/settings/environment/configuration-source";
import { OnHostOnlyServers } from "@/components/settings/environment/on-host-only-entries";

vi.mock("@/hooks/environment/team/use-team-viewing-host", () => ({
  useTeamViewingHost: () => ({
    client: {},
    viewingHost: { hostId: "host-a", hostLabel: "Mac mini" },
  }),
}));
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({
    data: {
      providers: [
        {
          providerId: "claude-code",
          nativeCapabilities: {
            mcp: { actionScopes: { list: ["global"] } },
          },
        },
      ],
    },
  }),
}));
vi.mock("@/components/settings/panels/use-provider-native-scope", () => ({
  useProviderNativeScope: () => ({ targets: [] }),
}));
vi.mock("@/hooks/host/use-host-queries", () => ({
  useHostQueriesWithResponseMap: () => [
    { name: "scratch", place: { scope: "global", target: null } },
  ],
}));
vi.mock("@/components/settings/host-scope/use-host-scope", () => ({
  usePersonalHostScope: () => ({ hostId: "host-a" }),
}));
vi.mock("@/components/settings/environment/mcp-servers-model", () => ({
  useConfigurationName: () => "Acme",
}));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => ({}),
  };
});
vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersion: () => ({ major: 1, minor: 5 }),
}));
vi.mock("@/hooks/providers/use-providers-promote-to-personal-mutation", () => ({
  useProvidersPromoteToPersonal: () => ({
    isPending: false,
    mutate: vi.fn(),
  }),
}));

afterEach(cleanup);

function pageFor(role: ConfigurationRole | null) {
  const source: ConfigurationSource = {
    kind: "pool",
    configuration: "team",
    environmentId: "env-acme",
    roomId: "room-acme",
    providerHandle: null,
    effectiveRole: role,
  };
  return (
    <ConfigurationSourceContext.Provider value={source}>
      <OnHostOnlyServers providerId="claude-code" environmentNames={[]} />
    </ConfigurationSourceContext.Provider>
  );
}

describe("Add to <name> in the on-host card", () => {
  it.each([null, "viewer"] as const)(
    "keeps the entry visible without Add when the role is %s",
    (role) => {
      render(pageFor(role));

      expect(screen.getByText("scratch")).toBeDefined();
      expect(screen.queryByRole("button", { name: "Add to Acme" })).toBeNull();
    },
  );
});
