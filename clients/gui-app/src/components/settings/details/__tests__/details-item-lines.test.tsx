import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentSecretRemovalV12 } from "@traycer/protocol/host/environment-schemas";
import {
  pendingRemovalSummary,
  secretsHostSummary,
} from "@/components/settings/details/secret-details-status";
import {
  DetailsDrawer,
  type DetailsItemRetry,
} from "@/components/settings/details/details-drawer";
import type {
  DetailsHostStatus,
  DetailsStatus,
  DetailsSubject,
} from "@/lib/settings-details-entry";

afterEach(() => {
  cleanup();
});

const AT = Date.UTC(2026, 9, 20, 9, 30);

function host(name: string, state: string): DetailsHostStatus {
  return {
    hostId: `id-${name}`,
    name,
    item: null,
    state,
    reason: null,
    at: AT,
    lastReportedAt: AT,
    recovery: null,
  };
}

describe("secretsHostSummary", () => {
  it("counts the hosts that applied the secrets", () => {
    expect(
      secretsHostSummary([
        host("dev-box", "applied"),
        host("laptop", "applied"),
      ]),
    ).toBe("Applied on 2 hosts");
    expect(secretsHostSummary([host("dev-box", "applied")])).toBe(
      "Applied on 1 host",
    );
  });

  it("names the host that could not apply them", () => {
    expect(
      secretsHostSummary([
        host("dev-box", "not_applied"),
        host("laptop", "applied"),
      ]),
    ).toBe("Not applied on dev-box");
  });

  it("names the host still applying them", () => {
    expect(
      secretsHostSummary([
        host("dev-box", "pending"),
        host("laptop", "applied"),
      ]),
    ).toBe("Applying on dev-box…");
  });

  it("says the secret is on no host when none reported", () => {
    expect(secretsHostSummary([])).toBe("Not on any host");
  });
});

function removalOf(
  targets: EnvironmentSecretRemovalV12["targets"],
): EnvironmentSecretRemovalV12 {
  return {
    outcome: "cleanup_requested",
    revokedAt: AT,
    destroyedAt: null,
    targets,
  };
}

describe("pendingRemovalSummary", () => {
  it("names the host still holding a copy", () => {
    expect(
      pendingRemovalSummary(
        removalOf([
          {
            target: "host",
            hostId: "id-dev-box",
            hostName: "dev-box",
            state: "requested",
            at: AT,
            failedAt: null,
          },
        ]),
        [],
      ),
    ).toBe("Cleanup requested · waiting for dev-box");
  });

  it("takes a name from the host rows when the target has none", () => {
    expect(
      pendingRemovalSummary(
        removalOf([
          {
            target: "host",
            hostId: "id-dev-box",
            hostName: null,
            state: "requested",
            at: AT,
            failedAt: null,
          },
        ]),
        [host("dev-box", "applied")],
      ),
    ).toBe("Cleanup requested · waiting for dev-box");
  });
});

const SUBJECT: DetailsSubject = {
  environmentId: "env-a",
  kind: "secret",
  key: "sec-cleanup",
};

function renderDrawer(input: {
  readonly status: DetailsStatus;
  readonly itemRetry: DetailsItemRetry;
}): void {
  render(
    <DetailsDrawer
      entry={{
        subject: SUBJECT,
        title: "Secrets",
        status: () => input.status,
        history: () => ({ readerScope: "status_only", entries: [] }),
        exportDiagnostics: () => Promise.reject(new Error("not exported")),
      }}
      title="Secrets"
      open
      onOpenChange={() => undefined}
      loading={false}
      error={null}
      exportPending={false}
      recoveryPending={false}
      onExport={() => undefined}
      onRetry={() => undefined}
      onRecover={() => undefined}
      onSubjectSelect={() => undefined}
      itemRetry={input.itemRetry}
      onBack={null}
      controls={null}
      initialTab="status"
    />,
  );
}

function status(overrides: Partial<DetailsStatus>): DetailsStatus {
  return {
    summary: "Not on any host",
    currentVersion: null,
    changedBy: null,
    changedAt: null,
    reason: null,
    hosts: [],
    ...overrides,
  };
}

describe("the drawer's item lines", () => {
  it("offers Retry on a retryable item and hands its subject back", async () => {
    const onRetry = vi.fn<(subject: DetailsSubject) => void>();
    renderDrawer({
      status: status({
        items: [
          {
            subject: SUBJECT,
            title: "CLEANUP_KEY",
            summary: "Cleanup requested · waiting for dev-box",
            at: null,
            retryable: true,
          },
          {
            subject: { ...SUBJECT, key: "sec-live" },
            title: "STRIPE_KEY",
            summary: "Set",
            at: AT,
            retryable: false,
          },
        ],
      }),
      itemRetry: { onRetry, pending: false, error: null },
    });

    const retries = await screen.findAllByRole("button", { name: "Retry" });
    expect(retries).toHaveLength(1);
    await userEvent.setup().click(retries[0]);

    expect(onRetry).toHaveBeenCalledWith(SUBJECT);
  });

  it("prints no time for an item without one", async () => {
    renderDrawer({
      status: status({
        items: [
          {
            subject: SUBJECT,
            title: "CLEANUP_KEY",
            summary: "Cleanup requested",
            at: null,
            retryable: false,
          },
        ],
      }),
      itemRetry: { onRetry: () => undefined, pending: false, error: null },
    });

    const title = await screen.findByText("CLEANUP_KEY");
    const line = title.nextElementSibling;
    expect(line?.textContent).toBe("Cleanup requested");
  });

  it("prints no Unknown for a change without an actor", async () => {
    renderDrawer({
      status: status({ changedAt: AT }),
      itemRetry: { onRetry: () => undefined, pending: false, error: null },
    });

    await screen.findByText("Now");
    expect(document.body.textContent).not.toContain("Unknown");
    expect(document.body.textContent).not.toContain("unknown");
  });
});
