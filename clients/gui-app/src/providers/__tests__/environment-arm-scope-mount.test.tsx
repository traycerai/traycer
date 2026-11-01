/**
 * What `EnvironmentArmScopeMount` tells the chat tile about the environment
 * arms: whether discovery has answered that there are none to read. The real
 * mount runs; the boundaries it reads (the pool plan, its stream client, the
 * negotiated support and the environment list) are stood in for. The fact is
 * read through its one consumer, `useEnvironmentArmsLackChat`, which answers
 * `false` while an arm is unsettled and the published absence when there are
 * no arms.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { EnvironmentListResponseV11 } from "@traycer/protocol/host/environment/contracts";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import { FakeStreamClient } from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";

const sources = vi.hoisted(
  (): {
    fetched: boolean;
    environments: EnvironmentListResponseV11["environments"];
    chats: StreamMethodSupport | null;
    client: unknown;
  } => ({ fetched: false, environments: [], chats: null, client: null }),
);

vi.mock(
  "@traycer-clients/shared/host-client/host-rpc-routing",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/host-rpc-routing")
      >();
    const { poolEntry: pool } =
      await import("@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures");
    return {
      ...actual,
      readProcessHostRpcTierPlan: () => ({ pool }),
    };
  },
);
vi.mock("@/hooks/host/use-pool-tier", () => ({
  usePoolTierStreamClient: () => sources.client,
}));
vi.mock("@/lib/host/stream-runtime-context", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/host/stream-runtime-context")
  >()),
  useStreamMethodSupportFor: (_client: unknown, method: string) =>
    method === "environment.chats.subscribe" ? sources.chats : null,
}));
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({
    isFetched: sources.fetched,
    data: sources.fetched ? { environments: sources.environments } : undefined,
  }),
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => null,
}));

import { EnvironmentArmScopeMount } from "@/providers/environment-arm-scope-mount";
import { useEnvironmentArmsLackChat } from "@/hooks/environment/use-environment-arms";
import { useAuthStore } from "@/stores/auth/auth-store";

const PERSONAL: EnvironmentListResponseV11["environments"][number] = {
  environmentId: "env-personal",
  ownerKind: "user",
  ownerId: "viewer-1",
  roomId: "room-personal",
  label: "Personal",
  effectiveRole: "owner",
  kind: "personal",
  hostCount: 1,
  providerHandle: null,
};
const TEAM: EnvironmentListResponseV11["environments"][number] = {
  environmentId: "env-team",
  ownerKind: "organization",
  ownerId: "team-1",
  roomId: "room-team",
  label: "Team",
  effectiveRole: "editor",
  kind: "team",
  hostCount: 1,
  providerHandle: "team",
};

function Probe(props: { readonly onRead: (lacks: boolean) => void }) {
  props.onRead(useEnvironmentArmsLackChat("task-1", "chat-1", "host-1"));
  return null;
}

/** What the chat tile reads once the mount has run. */
function lacksChat(): boolean {
  const read: { lacks: boolean | null } = { lacks: null };
  render(
    <>
      <EnvironmentArmScopeMount />
      <Probe
        onRead={(value) => {
          read.lacks = value;
        }}
      />
    </>,
  );
  if (read.lacks === null) throw new Error("the probe did not render");
  return read.lacks;
}

describe("EnvironmentArmScopeMount's absence of chat arms", () => {
  beforeEach(() => {
    sources.fetched = true;
    sources.environments = [PERSONAL];
    sources.chats = "supported";
    sources.client = new FakeStreamClient(true);
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "viewer-1", username: "V" },
    });
  });

  afterEach(() => {
    cleanup();
    useAuthStore.setState(useAuthStore.getInitialState(), true);
  });

  it("is not published while the environment list has not been fetched", () => {
    sources.fetched = false;

    expect(lacksChat()).toBe(false);
  });

  it("is published once the list holds only a personal environment and the chat arms are supported", () => {
    expect(lacksChat()).toBe(true);
  });

  it("is not published when the list holds a team environment, whose arm has not answered", () => {
    sources.environments = [PERSONAL, TEAM];

    expect(lacksChat()).toBe(false);
  });

  it("is not published while the pool's support for chat arms is unknown", () => {
    sources.chats = "unknown";

    expect(lacksChat()).toBe(false);
  });

  it("is not published before the pool's support for chat arms has been read", () => {
    sources.chats = null;

    expect(lacksChat()).toBe(false);
  });

  it("is published when the pool does not serve chat arms, whatever the list holds", () => {
    sources.chats = "unsupported";
    sources.environments = [PERSONAL, TEAM];

    expect(lacksChat()).toBe(true);
  });
});
