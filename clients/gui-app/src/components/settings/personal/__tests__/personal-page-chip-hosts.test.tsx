import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { PageChip } from "@/components/settings/personal/page-chip";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";

// The per-host reads and the account's Personal configuration are the
// boundary; the chip's own host rule runs for real.
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
  useHostClient: () => null,
}));
vi.mock("@/components/settings/details/use-details-environment-id", () => ({
  useDetailsEnvironmentId: () => "env-personal",
}));
vi.mock("@/components/settings/details/use-details-recovery", () => ({
  useDetailsRecovery: () => ({ recover: vi.fn(), pending: false }),
}));

beforeEach(() => {
  reads.statuses.clear();
  reads.versions.clear();
});

afterEach(() => {
  cleanup();
});

describe("the Personal page chip's hosts", () => {
  it("counts this window's own computer while the account's host list leaves it out", () => {
    // A new computer registers with remote access off, and the account's host
    // list omits it until remote access is on.
    const hosts = [
      hostScopeOptionFixture({
        hostId: "mac",
        name: "MacBook Pro",
        isLocalMachine: true,
        registered: false,
        item: null,
      }),
      hostScopeOptionFixture({
        hostId: "dev",
        name: "dev-box",
        isLocalMachine: false,
        registered: false,
        item: null,
      }),
    ];
    reads.scope = hostScopeFixture({
      hosts,
      host: hosts[0],
      activeHostId: "mac",
    });
    const running = environmentStatusFixture({
      principal: { kind: "personal" },
    });
    reads.statuses.set("mac", running);
    reads.statuses.set("dev", running);
    reads.versions.set("mac", { major: 1, minor: 1 });
    reads.versions.set("dev", { major: 1, minor: 1 });

    render(
      <QueryClientProvider client={new QueryClient()}>
        <PageChip section="mcp-servers" pick={PERSONAL_PICK} />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("button").textContent).toBe("✓ On MacBook Pro");
  });

  it("says Not on any computer or sandbox yet while no computer runs Personal", () => {
    const hosts = [
      hostScopeOptionFixture({
        hostId: "mac",
        name: "MacBook Pro",
        isLocalMachine: true,
        registered: false,
        item: null,
      }),
    ];
    reads.scope = hostScopeFixture({
      hosts,
      host: hosts[0],
      activeHostId: "mac",
    });
    reads.statuses.set("mac", environmentStatusFixture({ principal: null }));
    reads.versions.set("mac", { major: 1, minor: 1 });

    render(
      <QueryClientProvider client={new QueryClient()}>
        <PageChip section="mcp-servers" pick={PERSONAL_PICK} />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("button").textContent).toBe(
      "Not on any computer or sandbox yet",
    );
  });
});
