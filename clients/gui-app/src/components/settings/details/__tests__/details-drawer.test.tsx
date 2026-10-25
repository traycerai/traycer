const hoisted = vi.hoisted(() => ({
  recover: vi.fn<(recovery: { kind: string; hostId: string }) => void>(),
  saved: [] as { blob: Blob; name: string }[],
}));
vi.mock("@/components/settings/details/use-details-recovery", () => ({
  useDetailsRecovery: () => ({ recover: hoisted.recover, pending: false }),
}));
vi.mock("@/lib/files/save-blob-to-disk", () => ({
  saveBlobToDisk: (blob: Blob, name: string) => {
    hoisted.saved.push({ blob, name });
    return Promise.resolve({ name, path: null });
  },
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

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentHistoryResponse } from "@traycer/protocol/host/environment/configuration-contracts";
import type {
  EnvironmentSecretRemoval,
  EnvironmentSecretsListResponseV11,
  EnvironmentSecretsVersionsResponseV11,
} from "@traycer/protocol/host/environment-schemas";
import { SettingsDetailsDialog } from "@/components/settings/details/settings-details-button";
import {
  mountTeamPage,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import { useAuthStore } from "@/stores/auth/auth-store";

const AT = Date.UTC(2026, 9, 20, 9, 30);
const DAY = 24 * 60 * 60 * 1_000;

function formatted(at: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(at);
}

beforeEach(() => {
  hoisted.saved.length = 0;
  useAuthStore.setState({
    contextMetadata: { userId: "user-me", username: "me" },
  });
});

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  useAuthStore.setState({ contextMetadata: null });
  hoisted.recover.mockReset();
});

function history(
  overrides: Partial<EnvironmentHistoryResponse>,
): EnvironmentHistoryResponse {
  return {
    readerScope: "full",
    entries: [],
    hostStates: [],
    ...overrides,
  };
}

const brokenHost = {
  hostId: "host-a",
  hostName: "dev-box",
  state: "not_applied",
  reason: "permission_denied",
  at: AT,
  lastReportedAt: AT,
};

// Not fresh literals: a host that over-delivers is what the export must survive.
const LEAKY_ENTRY = {
  at: AT,
  actor: { label: "Ada", tombstoned: true, email: "ada@example.com" },
  operation: "set",
  outcome: "applied",
  value: "sk_live_SECRET_VALUE",
};
const LEAKY_HOST = { ...brokenHost, token: "tok_SECRET" };

function openDrawer(
  harness: TeamPageHarness,
  subject: { kind: string; key: string },
  title: string,
): void {
  render(
    <SettingsDetailsDialog
      subject={{ environmentId: "env-a", ...subject }}
      title={title}
      controls={null}
      open
      onOpenChange={() => undefined}
    />,
    { wrapper: harness.Wrapper },
  );
}

async function savedExport(): Promise<Record<string, unknown>> {
  await waitFor(() => {
    expect(hoisted.saved).toHaveLength(1);
  });
  const { blob } = hoisted.saved[0];
  const text = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(new Error("could not read the saved file"));
    reader.readAsText(blob);
  });
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null)
    throw new Error("the saved file is not an object");
  return Object.fromEntries(Object.entries(parsed));
}

describe("the drawer's reader scopes", () => {
  it("draws no History tab for status_only, and still shows the host status", async () => {
    const harness = mountTeamPage(poolSource("viewer"), {
      "environment.history": () =>
        history({ readerScope: "status_only", hostStates: [brokenHost] }),
    });
    openDrawer(harness, { kind: "member", key: "u-2" }, "Member");

    expect(
      await screen.findByRole("button", { name: "Repair on dev-box" }),
    ).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Status" })).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "Export diagnostics" }),
    ).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "History" })).toBeNull();
  });

  it("shows a reader's own history under a scope note", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.history": () =>
        history({
          readerScope: "own",
          entries: [
            {
              at: AT,
              actor: { label: "Me", tombstoned: false },
              operation: "set",
              outcome: "applied",
            },
          ],
          hostStates: [brokenHost],
        }),
    });
    const user = userEvent.setup();
    openDrawer(harness, { kind: "variable", key: "FOO" }, "FOO");

    await user.click(await screen.findByRole("tab", { name: "History" }));

    expect(
      screen.getByText("Your changes and their current status."),
    ).toBeTruthy();
    expect(screen.getByText("set · applied")).toBeTruthy();
    expect(screen.getByText(`Me · ${formatted(AT)}`)).toBeTruthy();
  });

  it("shows the full history with no scope note, newest status as the change line", async () => {
    const harness = mountTeamPage(poolSource("admin"), {
      "environment.history": () =>
        history({
          entries: [
            {
              at: AT,
              actor: { label: "Ada", tombstoned: false },
              operation: "set",
              outcome: "applied",
            },
            {
              at: AT - DAY,
              actor: null,
              operation: "sync",
              outcome: "applied",
            },
          ],
        }),
    });
    const user = userEvent.setup();
    openDrawer(harness, { kind: "variable", key: "FOO" }, "FOO");

    expect(await screen.findByText(`Ada · ${formatted(AT)}`)).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "History" }));

    expect(screen.queryByText(/Your changes/)).toBeNull();
    expect(screen.getByText("sync · applied")).toBeTruthy();
    expect(screen.getByText(`Traycer · ${formatted(AT - DAY)}`)).toBeTruthy();
  });

  it("offers Retry for a failed setup script, and only the reason for a failed setting", async () => {
    const failedHost = { ...brokenHost, reason: "apply_failed" };
    const harness = mountTeamPage(poolSource("admin"), {
      "environment.history": () => history({ hostStates: [failedHost] }),
    });
    const user = userEvent.setup();
    openDrawer(harness, { kind: "variable", key: "FOO" }, "FOO");

    expect(
      await screen.findByText(`Not applied · ${formatted(AT)} · apply_failed`),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    cleanup();
    openDrawer(harness, { kind: "setup_script", key: "macos" }, "Setup");
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    expect(hoisted.recover.mock.calls).toEqual([
      [{ kind: "retry", hostId: "host-a" }],
    ]);
  });

  it("sends the subject, or null for the chip, to environment.history", async () => {
    const harness = mountTeamPage(poolSource("admin"), {
      "environment.history": () => history({}),
    });
    openDrawer(harness, { kind: "chip", key: "secrets" }, "Settings delivery");
    await screen.findByRole("tab", { name: "Status" });

    expect(harness.paramsOf("environment.history")).toEqual([
      { environmentId: "env-a", subject: null },
    ]);
  });
});

describe("the subject's own controls", () => {
  function openWithControls(
    harness: TeamPageHarness,
    controls: ReactNode,
  ): void {
    render(
      <SettingsDetailsDialog
        subject={{ environmentId: "env-a", kind: "variable", key: "FOO" }}
        title="FOO"
        controls={controls}
        open
        onOpenChange={() => undefined}
      />,
      { wrapper: harness.Wrapper },
    );
  }

  it("shows them under the status, in the Status tab", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.history": () => history({ hostStates: [brokenHost] }),
    });
    openWithControls(harness, <p data-testid="own-controls">Verify here</p>);

    // The controls show before the status is read; they sit under it once it is.
    const repair = await screen.findByRole("button", {
      name: "Repair on dev-box",
    });
    const controls = screen.getByTestId("own-controls");
    expect(
      repair.compareDocumentPosition(controls) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows them beside the failure line when the details cannot be read", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.history": () => history({}),
      "environment.secrets.list": () => ({ removed: [], secrets: [] }),
    });
    render(
      <SettingsDetailsDialog
        subject={{
          environmentId: "env-a",
          kind: "secret",
          key: "sec-unknown",
        }}
        title="Gone"
        controls={<p data-testid="own-controls">Verify here</p>}
        open
        onOpenChange={() => undefined}
      />,
      { wrapper: harness.Wrapper },
    );

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Couldn't load details.Retry",
    );
    expect(screen.getByTestId("own-controls")).toBeTruthy();
  });

  it("shows nothing extra when the subject has none", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.history": () => history({ hostStates: [brokenHost] }),
    });
    openWithControls(harness, null);

    await screen.findByRole("button", { name: "Repair on dev-box" });
    expect(screen.queryByTestId("own-controls")).toBeNull();
  });
});

describe("Export diagnostics", () => {
  it("keeps an export failure's own message, not the details-load line", async () => {
    let reads = 0;
    const harness = mountTeamPage(poolSource("admin"), {
      "environment.history": () => {
        reads += 1;
        if (reads > 1) throw new Error("Couldn't reach the history.");
        return history({ hostStates: [LEAKY_HOST] });
      },
    });
    const user = userEvent.setup();
    openDrawer(harness, { kind: "variable", key: "FOO" }, "FOO");
    await user.click(
      await screen.findByRole("tab", { name: "Export diagnostics" }),
    );
    await user.click(screen.getByRole("button", { name: "Save diagnostics" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't reach the history.");
    expect(alert.textContent).not.toContain("Couldn't load details.");
  });

  it("saves a sanitized export from a fresh, re-authorized read", async () => {
    let scope: EnvironmentHistoryResponse["readerScope"] = "full";
    const harness = mountTeamPage(poolSource("admin"), {
      "environment.history": () => ({
        ...history({
          readerScope: scope,
          entries: scope === "full" ? [LEAKY_ENTRY] : [],
          hostStates: [LEAKY_HOST],
        }),
      }),
    });
    const user = userEvent.setup();
    openDrawer(harness, { kind: "variable", key: "FOO" }, "FOO");
    await user.click(
      await screen.findByRole("tab", { name: "Export diagnostics" }),
    );
    expect(harness.paramsOf("environment.history")).toHaveLength(1);

    // The reader lost History rights while the drawer stayed open.
    scope = "status_only";
    await user.click(screen.getByRole("button", { name: "Save diagnostics" }));
    const exported = await savedExport();

    expect(harness.paramsOf("environment.history")).toHaveLength(2);
    expect(hoisted.saved[0].name).toBe("traycer-settings-diagnostics.json");
    const { exportedAt, ...rest } = exported;
    expect(typeof exportedAt).toBe("number");
    expect(rest).toEqual({
      subject: { environmentId: "env-a", kind: "variable", key: "FOO" },
      title: "Settings",
      status: {
        summary: "Current status",
        currentVersion: null,
        changedBy: null,
        changedAt: null,
        reason: null,
        hosts: [
          {
            hostId: "host-a",
            name: "dev-box",
            item: null,
            state: "not_applied",
            reason: "permission_denied",
            at: AT,
            lastReportedAt: AT,
            recovery: { kind: "repair", hostId: "host-a" },
          },
        ],
      },
      history: { readerScope: "status_only", entries: [] },
    });
    expect(JSON.stringify(exported)).not.toMatch(
      /SECRET|ada@example|email|token|value/,
    );
  });

  it("projects a full history to metadata only", async () => {
    const harness = mountTeamPage(poolSource("admin"), {
      "environment.history": () => ({
        ...history({
          entries: [LEAKY_ENTRY],
        }),
      }),
    });
    const user = userEvent.setup();
    openDrawer(harness, { kind: "variable", key: "FOO" }, "FOO");
    await user.click(
      await screen.findByRole("tab", { name: "Export diagnostics" }),
    );
    await user.click(screen.getByRole("button", { name: "Save diagnostics" }));

    const exported = await savedExport();
    expect(exported).toMatchObject({
      history: {
        readerScope: "full",
        entries: [
          {
            at: AT,
            actor: { label: "Ada", tombstoned: true },
            operation: "set",
            outcome: "applied",
            hosts: [],
          },
        ],
      },
    });
    expect(JSON.stringify(exported)).not.toMatch(/SECRET|ada@example/);
  });
});

function removal(
  overrides: Partial<EnvironmentSecretRemoval>,
): EnvironmentSecretRemoval {
  return {
    outcome: "revoked",
    revokedAt: AT,
    destroyedAt: null,
    targets: [],
    ...overrides,
  };
}

describe("the Secrets header's Details", () => {
  const secretsList: EnvironmentSecretsListResponseV11 = {
    secrets: [
      {
        secretId: "sec-live",
        name: "STRIPE_KEY",
        kind: "api_key",
        protocol: null,
        destinations: [],
        mode: "brokered",
        state: "live",
        currentVersionId: "ver-1",
        revoked: false,
        updatedAt: AT,
      },
      {
        secretId: "sec-revoked",
        name: "REVOKED_KEY",
        kind: "api_key",
        protocol: null,
        destinations: [],
        mode: "brokered",
        state: "live",
        currentVersionId: null,
        revoked: true,
        updatedAt: AT,
      },
    ],
    removed: [
      { id: "sec-revoked", name: "REVOKED_KEY", removal: removal({}) },
      {
        id: "sec-cleanup",
        name: "CLEANUP_KEY",
        removal: removal({ outcome: "cleanup_requested" }),
      },
      {
        id: "sec-recent",
        name: "RECENT_DESTROYED",
        removal: removal({
          outcome: "destroyed",
          destroyedAt: Date.now() - 2 * DAY,
        }),
      },
      {
        id: "sec-old",
        name: "OLD_DESTROYED",
        removal: removal({
          outcome: "destroyed",
          destroyedAt: Date.now() - 31 * DAY,
        }),
      },
    ],
  };

  it("lists secrets and the last 30 days of removals, each with its outcome", async () => {
    const harness = mountTeamPage(poolSource("viewer"), {
      "environment.history": () => history({}),
      "environment.secrets.list": () => secretsList,
    });
    openDrawer(harness, { kind: "secret", key: "" }, "Secrets");

    expect(await screen.findByText("Secrets and recent removals")).toBeTruthy();
    const items = screen.getAllByRole("listitem").map((row) => row.textContent);
    expect(items).toEqual([
      expect.stringContaining("STRIPE_KEY"),
      expect.stringContaining("REVOKED_KEY"),
      expect.stringContaining("CLEANUP_KEY"),
      expect.stringContaining("RECENT_DESTROYED"),
    ]);
    expect(items[1]).toContain("Access revoked");
    expect(items[2]).toContain("Cleanup requested");
    expect(items[3]).toContain("Destroyed");
    expect(screen.queryByText("OLD_DESTROYED")).toBeNull();
    const call = harness.messenger.calls.find(
      (entry) => entry.method === "environment.secrets.list",
    );
    expect(call?.requiredHostMethodVersion).toEqual({
      method: "environment.secrets.list",
      version: { major: 1, minor: 1 },
    });
  });

  it("opens one removed secret's own details from its row", async () => {
    const versions: EnvironmentSecretsVersionsResponseV11 = {
      versions: [
        {
          versionId: "ver-2",
          ordinal: 2,
          createdAt: AT,
          supersededAt: null,
          destroyedAt: null,
          current: true,
          rotationState: null,
        },
      ],
      removal: removal({
        outcome: "cleanup_requested",
        targets: [
          {
            target: "host",
            hostId: "host-a",
            hostName: "dev-box",
            state: "confirmed",
            at: AT,
          },
          {
            target: "broker_current",
            hostId: null,
            hostName: null,
            state: "requested",
            at: AT,
          },
        ],
      }),
    };
    const harness = mountTeamPage(poolSource("viewer"), {
      "environment.history": () => history({}),
      "environment.secrets.list": () => secretsList,
      "environment.secrets.versions": () => versions,
    });
    const user = userEvent.setup();
    openDrawer(harness, { kind: "secret", key: "" }, "Secrets");
    const row = (await screen.findByText("CLEANUP_KEY")).closest("li");
    await user.click(
      (row as HTMLElement).querySelector("button") as HTMLButtonElement,
    );

    expect(await screen.findByText("Cleanup requested")).toBeTruthy();
    expect(screen.getByText("Version 2")).toBeTruthy();
    expect(screen.getByText("1 of 2 copies removed")).toBeTruthy();
    expect(harness.paramsOf("environment.secrets.versions")).toEqual([
      { environmentId: "env-a", secretId: "sec-cleanup" },
    ]);
    const call = harness.messenger.calls.find(
      (entry) => entry.method === "environment.secrets.versions",
    );
    expect(call?.requiredHostMethodVersion).toEqual({
      method: "environment.secrets.versions",
      version: { major: 1, minor: 1 },
    });
  });

  it("reads a destroyed secret from the list alone, without a versions read", async () => {
    const harness = mountTeamPage(poolSource("viewer"), {
      "environment.history": () => history({}),
      "environment.secrets.list": () => secretsList,
    });
    openDrawer(harness, { kind: "secret", key: "sec-recent" }, "RECENT");

    expect(await screen.findByText("Destroyed")).toBeTruthy();
    expect(harness.paramsOf("environment.secrets.versions")).toEqual([]);
  });

  it("reads a details failure as one line with a Retry link, and re-reads on Retry", async () => {
    const harness = mountTeamPage(poolSource("viewer"), {
      "environment.history": () => history({}),
      "environment.secrets.list": () => secretsList,
    });
    const user = userEvent.setup();
    openDrawer(harness, { kind: "secret", key: "sec-unknown" }, "Gone");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Couldn't load details.Retry");
    const reads = harness.paramsOf("environment.secrets.list").length;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(
        harness.paramsOf("environment.secrets.list").length,
      ).toBeGreaterThan(reads);
    });
  });
});
