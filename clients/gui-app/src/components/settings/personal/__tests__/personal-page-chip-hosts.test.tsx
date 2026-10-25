import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EnvironmentDescriptorV11,
  EnvironmentHostRecordV12,
} from "@traycer/protocol/host/environment/contracts";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { PageChip } from "@/components/settings/personal/page-chip";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import {
  mountTeamPage,
  personalPoolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";

// The window's host scope and the per-host status reads are the boundary;
// the account's environment list and host list go through the real client,
// and the chip's own host rule runs for real.
const reads = vi.hoisted(
  (): {
    scope: HostScope | null;
    readonly statuses: Map<string, unknown>;
    readonly versions: Map<string, unknown>;
  } => ({
    scope: null,
    statuses: new Map<string, unknown>(),
    versions: new Map<string, unknown>(),
  }),
);
vi.mock("@/components/settings/host-scope/use-host-scope", () => ({
  useHostScope: () => reads.scope,
}));
vi.mock("@/hooks/environment/use-registered-host-environment-statuses", () => ({
  useRegisteredHostEnvironmentStatuses: () => reads.statuses,
}));
vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersions: () => reads.versions,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));
vi.mock("@/components/settings/details/use-details-environment-id", () => ({
  useDetailsEnvironmentId: () => "env-personal",
}));
vi.mock("@/components/settings/details/use-details-recovery", () => ({
  useDetailsRecovery: () => ({ recover: vi.fn(), pending: false }),
}));

const personal: EnvironmentDescriptorV11 = {
  environmentId: "env-personal",
  ownerKind: "user",
  ownerId: "user-me",
  roomId: "room-personal",
  label: "Personal",
  effectiveRole: "owner",
  kind: "personal",
  hostCount: 3,
  providerHandle: null,
};

function listed(
  hostId: string,
  hostLabel: string,
  applied: EnvironmentHostRecordV12["applied"],
): EnvironmentHostRecordV12 {
  return {
    hostId,
    hostLabel,
    hostPlatform: "darwin",
    enrolledByUserId: "user-me",
    kind: "personal",
    boundAt: 1,
    reachable: false,
    lastReportedAt: 1,
    applied,
    hasLocalRow: false,
  };
}

function windowHostOnly(): void {
  const mac = hostScopeOptionFixture({
    hostId: "mac",
    name: "MacBook Pro",
    isLocalMachine: true,
    registered: false,
    item: null,
  });
  reads.scope = hostScopeFixture({
    hosts: [mac],
    host: mac,
    activeHostId: "mac",
  });
  reads.statuses.set(
    "mac",
    environmentStatusFixture({ principal: { kind: "personal" } }),
  );
  reads.versions.set("mac", { major: 1, minor: 1 });
}

function mountChip(
  hostList: () =>
    | { hosts: EnvironmentHostRecordV12[] }
    | Promise<{ hosts: EnvironmentHostRecordV12[] }>,
) {
  const harness = mountTeamPage(personalPoolSource(), {
    "environment.list": () => ({ environments: [personal] }),
    "environment.host.list": hostList,
  });
  render(
    <div data-testid="chip">
      <PageChip section="mcp-servers" pick={PERSONAL_PICK} />
    </div>,
    { wrapper: harness.Wrapper },
  );
  return harness;
}

const chipText = () => screen.getByTestId("chip").textContent;

async function settle(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  reads.statuses.clear();
  reads.versions.clear();
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetTeamPageHarness();
});

describe("the Personal page chip's hosts", () => {
  it("names the hosts in the account's host list when only this window's host is dialable", async () => {
    windowHostOnly();
    mountChip(() => ({
      hosts: [
        listed("mac", "MacBook Pro", []),
        listed("dev", "dev-box", []),
        listed("ci", "ci-box", []),
      ],
    }));
    await settle(1_000);

    expect(chipText()).toBe("✓ On MacBook Pro, dev-box and 1 more");
  });

  it("names this computer only once its own status has answered", async () => {
    windowHostOnly();
    reads.statuses.delete("mac");
    mountChip(() => ({
      hosts: [listed("mac", "MacBook Pro", []), listed("dev", "dev-box", [])],
    }));
    await settle(1_000);
    expect(chipText()).toBe("✓ On dev-box");
    cleanup();

    windowHostOnly();
    mountChip(() => ({
      hosts: [listed("mac", "MacBook Pro", []), listed("dev", "dev-box", [])],
    }));
    await settle(1_000);
    expect(chipText()).toBe("✓ On MacBook Pro and dev-box");
  });

  it("leaves out a listed host that has a Local row", async () => {
    windowHostOnly();
    mountChip(() => ({
      hosts: [
        listed("mac", "MacBook Pro", []),
        { ...listed("dev", "dev-box", []), hasLocalRow: true },
      ],
    }));
    await settle(1_000);
    expect(chipText()).toBe("✓ On MacBook Pro");
  });

  it("claims nothing while the host list is loading or has failed", async () => {
    windowHostOnly();
    mountChip(() => {
      throw HostRpcError.fromWireEnvelope(
        { code: "INTERNAL", message: "down" },
        "req-list",
        "environment.host.list",
      );
    });
    await settle(1_000);
    expect(chipText()).toBe("");
    cleanup();

    mountChip(() => new Promise(() => undefined));
    await settle(1_000);
    expect(chipText()).toBe("");
  });

  it("says a host hasn't confirmed once it has read Applying for 30 seconds", async () => {
    windowHostOnly();
    mountChip(() => ({
      hosts: [
        listed("dev", "dev-box", [
          {
            itemKey: "mcp_server:docs",
            state: "received",
            reason: null,
            at: 1,
          },
        ]),
      ],
    }));
    await settle(1_000);
    expect(chipText()).toBe("Applying on dev-box…");

    await settle(30_000);
    expect(
      screen.getByRole("button", { name: "dev-box hasn't confirmed" }),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Details" })).toBeDefined();
  });
});
