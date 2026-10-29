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
vi.mock("@/hooks/host/use-host-client-for-host-id", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/host/use-host-client-for-host-id")
  >()),
  useHostClientForHostId: (hostId: string | null) =>
    requireTeamHostClient().createRequesterForHostId(hostId),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentHistoryResponse } from "@traycer/protocol/host/environment/configuration-contracts";
import { environmentStatusResponseSchemaV11 } from "@traycer/protocol/host/environment-schemas";
import type {
  EnvironmentSecretRemovalV12,
  EnvironmentSecretsListResponseV12,
  EnvironmentSecretsVersionsResponseV11,
} from "@traycer/protocol/host/environment-schemas";
import { SettingsDetailsDialog } from "@/components/settings/details/settings-details-button";
import type { DetailsSubject } from "@/lib/settings-details-entry";
import {
  mountTeamPage,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import { useAuthStore } from "@/stores/auth/auth-store";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { sandboxQueryKeys } from "@/lib/query-keys";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { formatSettingsDate } from "@/lib/settings/settings-date";

const AT = Date.UTC(2026, 9, 20, 9, 30);
const DAY = 24 * 60 * 60 * 1_000;

// The Settings date rule itself is pinned in settings-date.test.ts.
function formatted(at: number): string {
  return formatSettingsDate(at, true);
}

beforeEach(() => {
  hoisted.saved.length = 0;
  useAuthStore.setState({
    contextMetadata: { userId: "user-me", username: "me" },
  });
});

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
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
  subject: Omit<DetailsSubject, "environmentId">,
  title: string,
): void {
  render(
    <SettingsDetailsDialog
      subject={{ environmentId: "env-a", ...subject }}
      title={title}
      controls={null}
      open
      onOpenChange={() => undefined}
      initialTab="status"
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
    // A setting, not a member: a member's `Now` names no host at all, so it
    // could not carry this case's host status.
    openDrawer(harness, { kind: "host_settings", key: "k-1" }, "Settings");

    expect(
      await screen.findByRole("button", { name: "Open dev-box" }),
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

    expect(
      await screen.findByText(`Last change ${formatted(AT)}`),
    ).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "History" }));

    expect(screen.queryByText(/Your changes/)).toBeNull();
    expect(screen.getByText("sync · applied")).toBeTruthy();
    expect(screen.getByText(`Traycer · ${formatted(AT - DAY)}`)).toBeTruthy();
  });

  it("prints no Unknown or unknown for an actor or a time the app does not have", async () => {
    const harness = mountTeamPage(poolSource("admin"), {
      "environment.history": () =>
        history({
          entries: [
            {
              at: AT,
              actor: null,
              operation: "sync",
              outcome: "applied",
            },
          ],
          hostStates: [
            {
              ...brokenHost,
              state: "applied",
              reason: null,
              at: null,
              lastReportedAt: null,
            },
          ],
        }),
    });
    openDrawer(harness, { kind: "variable", key: "FOO" }, "FOO");

    expect(await screen.findByText("Applied on 1 host")).toBeTruthy();
    expect(screen.getByText(`Last change ${formatted(AT)}`)).toBeTruthy();
    expect(screen.getByText("Applied")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/unknown/i);
  });

  // NEW-145-20: the line under "Now" read "windows-test-machine · 15:06" — a
  // host name and a time with nothing to say which they were.
  it("labels the change line and leaves out a time the app does not have", async () => {
    const harness = mountTeamPage(poolSource("admin"), {
      "environment.history": () =>
        history({
          entries: [
            {
              at: AT,
              actor: { label: "windows-test-machine", tombstoned: false },
              operation: "set",
              outcome: "applied",
            },
          ],
        }),
    });
    openDrawer(harness, { kind: "variable", key: "FOO" }, "FOO");

    expect(
      await screen.findByText(`Last change ${formatted(AT)}`),
    ).toBeTruthy();
    expect(
      screen.queryByText(`windows-test-machine · ${formatted(AT)}`),
    ).toBeNull();
    cleanup();

    const noHistory = mountTeamPage(poolSource("admin"), {
      "environment.history": () => history({}),
    });
    openDrawer(noHistory, { kind: "variable", key: "FOO" }, "FOO");
    await screen.findByRole("tab", { name: "Status" });
    expect(screen.queryByText(/Last change/)).toBeNull();
  });

  it("offers Retry for a failed setup script, and no raw code for a failed setting", async () => {
    const failedHost = { ...brokenHost, reason: "apply_failed" };
    const harness = mountTeamPage(poolSource("admin"), {
      "environment.history": () => history({ hostStates: [failedHost] }),
    });
    const user = userEvent.setup();
    openDrawer(harness, { kind: "variable", key: "FOO" }, "FOO");

    // A raw applier code is for Export diagnostics only.
    expect(
      await screen.findByText(`Not applied · ${formatted(AT)}`),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("apply_failed");
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
        initialTab="status"
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
      name: "Open dev-box",
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
        initialTab="status"
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

    await screen.findByRole("button", { name: "Open dev-box" });
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
        summary: "1 not applied on dev-box",
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
  overrides: Partial<EnvironmentSecretRemovalV12>,
): EnvironmentSecretRemovalV12 {
  return {
    outcome: "revoked",
    revokedAt: AT,
    destroyedAt: null,
    targets: [],
    ...overrides,
  };
}

describe("the Secrets header's Details", () => {
  const secretsList: EnvironmentSecretsListResponseV12 = {
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
        variables: [],
        providerVariables: [],
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
        variables: [],
        providerVariables: [],
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

    // No host has reported yet, so the page's Now says so.
    expect(await screen.findByText("No hosts yet")).toBeTruthy();
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
    // Only a removal still under way can be retried.
    expect(items.map((item) => item.includes("Retry"))).toEqual([
      false,
      true,
      true,
      false,
    ]);
    expect(screen.queryByText("OLD_DESTROYED")).toBeNull();
    const call = harness.messenger.calls.find(
      (entry) => entry.method === "environment.secrets.list",
    );
    expect(call?.requiredHostMethodVersion).toEqual({
      method: "environment.secrets.list",
      version: { major: 1, minor: 1 },
    });
  });

  it("opens one removed secret's own details and retries its unfinished cleanup", async () => {
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
            failedAt: null,
          },
          {
            target: "broker_current",
            hostId: null,
            hostName: null,
            state: "requested",
            at: AT,
            failedAt: null,
          },
        ],
      }),
    };
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.history": () => history({}),
      "environment.secrets.list": () => secretsList,
      "environment.secrets.versions": () => versions,
      "environment.secrets.destroy": () => ({ outcome: "revoked" as const }),
    });
    const user = userEvent.setup();
    openDrawer(harness, { kind: "secret", key: "" }, "Secrets");
    const row = (await screen.findByText("CLEANUP_KEY")).closest("li");
    await user.click(
      within(row as HTMLElement).getByRole("button", { name: "Details" }),
    );

    expect(await screen.findByText(/Cleanup requested/)).toBeTruthy();
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

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(harness.paramsOf("environment.secrets.destroy")).toEqual([
        { environmentId: "env-a", secretId: "sec-cleanup", versionId: "ver-2" },
      ]);
    });
  });

  it("retries a removal still under way by removing its current version again", async () => {
    const harness = mountTeamPage(poolSource("editor"), {
      "environment.history": () => history({}),
      "environment.secrets.list": () => secretsList,
      "environment.secrets.versions": () => ({
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
        removal: null,
      }),
      "environment.secrets.destroy": () => ({ outcome: "revoked" as const }),
    });
    const user = userEvent.setup();
    openDrawer(harness, { kind: "secret", key: "" }, "Secrets");
    const row = (await screen.findByText("CLEANUP_KEY")).closest("li");
    await user.click(
      within(row as HTMLElement).getByRole("button", { name: "Retry" }),
    );

    await waitFor(() => {
      expect(harness.paramsOf("environment.secrets.destroy")).toEqual([
        { environmentId: "env-a", secretId: "sec-cleanup", versionId: "ver-2" },
      ]);
    });
    expect(harness.paramsOf("environment.secrets.versions")).toEqual([
      { environmentId: "env-a", secretId: "sec-cleanup" },
    ]);
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

describe("a history-reported unused setting", () => {
  const unusedHost = (reason: string | null) => ({
    hostId: "host-sbx",
    hostName: "Build box",
    state: "not_used",
    reason,
    at: AT,
    lastReportedAt: AT,
  });

  function mountUnused(reason: string | null): TeamPageHarness {
    return mountTeamPage(poolSource("admin"), {
      "environment.history": () =>
        history({ hostStates: [unusedHost(reason)] }),
    });
  }

  it("names a known harness key by its product, never by the raw key", async () => {
    const harness = mountUnused("claude:ANTHROPIC_API_KEY");
    openDrawer(harness, { kind: "chip", key: "" }, "Settings delivery");

    const row = await screen.findByText(/not used on sandboxes/);
    expect(row.textContent).toBe("Claude Code key · not used on sandboxes");
    expect(document.body.textContent).not.toMatch(/ANTHROPIC_API_KEY|claude:/);
  });

  it("keeps an already-friendly label as it is", async () => {
    const harness = mountUnused("Claude Code key");
    openDrawer(harness, { kind: "chip", key: "" }, "Settings delivery");

    const row = await screen.findByText(/not used on sandboxes/);
    expect(row.textContent).toBe("Claude Code key · not used on sandboxes");
  });

  it("uses a generic label for an unknown harness instead of exposing its key", async () => {
    const harness = mountUnused("future_harness:PRIVATE_KEY");
    openDrawer(harness, { kind: "chip", key: "" }, "Settings delivery");

    const row = await screen.findByText(/not used on sandboxes/);
    expect(row.textContent).toBe("Agent key · not used on sandboxes");
    expect(document.body.textContent).not.toMatch(/future_harness|PRIVATE_KEY/);
  });

  it("falls back to a generic key label when the host names no setting, never printing null", async () => {
    const harness = mountUnused(null);
    openDrawer(harness, { kind: "chip", key: "" }, "Settings delivery");

    const row = await screen.findByText(/not used on sandboxes/);
    expect(row.textContent).toBe("Agent key · not used on sandboxes");
    expect(document.body.textContent).not.toMatch(/\bnull\b/);
  });

  it("keeps the raw key in the diagnostics export for support", async () => {
    const harness = mountUnused("claude:ANTHROPIC_API_KEY");
    const user = userEvent.setup();
    openDrawer(harness, { kind: "chip", key: "" }, "Settings delivery");
    await screen.findByText(/not used on sandboxes/);

    await user.click(
      await screen.findByRole("tab", { name: "Export diagnostics" }),
    );
    await user.click(screen.getByRole("button", { name: "Save diagnostics" }));
    const exported = await savedExport();

    expect(exported).toMatchObject({
      status: {
        hosts: [
          {
            item: "Claude Code key",
            reason: "claude:ANTHROPIC_API_KEY",
          },
        ],
      },
    });
  });
});

describe("a sandbox's unused settings", () => {
  const HOST_ID = mockLocalHostEntry.hostId;
  const sandboxHost = {
    hostId: HOST_ID,
    hostName: "stale-name",
    state: "applied",
    reason: null,
    at: AT,
    lastReportedAt: AT,
  };
  const status = environmentStatusResponseSchemaV11.parse({
    principal: { kind: "personal" },
    reachability: "connected",
    bindingGeneration: 1,
    desiredRevision: 5,
    receivedRevision: 5,
    appliedRevision: 5,
    receiptAgeMs: 0,
    remoteAccess: "on",
    pendingUploads: [],
    setup: null,
    items: [
      {
        kind: "env_override",
        key: "claude:ANTHROPIC_API_KEY",
        os: "any",
        desiredRevision: 3,
        status: "not_used",
        code: "ok",
        args: { exitStatus: null, stage: null, durationMs: null, kind: null },
        brokerEnforced: null,
        minimumHostVersion: null,
        appliedAs: null,
      },
    ],
  });

  function mountChip(
    guestConfigured: boolean | null,
    delivered: typeof status,
  ): TeamPageHarness {
    const harness = mountTeamPage(poolSource("admin"), {
      "environment.history": () => history({ hostStates: [sandboxHost] }),
      "environment.status": () => delivered,
    });
    harness.queryClient.setQueryDefaults(sandboxQueryKeys.listAll(), {
      gcTime: Number.POSITIVE_INFINITY,
    });
    harness.queryClient.setQueryData(sandboxQueryKeys.list({}, "user-me"), {
      sandboxes: [
        sandboxSummaryFixture({
          hostId: HOST_ID,
          displayName: "Build box",
          state: "awake",
          guestConfigured,
        }),
      ],
    });
    return harness;
  }

  it("lists each unused key as a named row under the sandbox, never printing the variable or a reason", async () => {
    const harness = mountChip(null, status);
    openDrawer(harness, { kind: "chip", key: "" }, "Settings delivery");

    const row = await screen.findByText(/key · not used on sandboxes/);
    expect(row.textContent).toMatch(
      /^Claude Code key · not used on sandboxes$/,
    );
    expect(screen.getAllByText(/Build box/).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(
      /ANTHROPIC_API_KEY|permission_denied/,
    );
    expect(harness.paramsOf("environment.status")).toHaveLength(1);
  });

  describe("the recovery for a sandbox whose settings did not apply", () => {
    function advertiseRepair(minor: number): void {
      recordNegotiatedHostManifest(HOST_ID, {
        "host.sandbox.repairGuestConfiguration": { major: 1, minor },
      });
    }

    // The guest is fine; only a settings item failed to apply.
    const environmentFailed = environmentStatusResponseSchemaV11.parse({
      ...status,
      items: [
        {
          ...status.items[0],
          key: "VAR",
          kind: "variable",
          status: "failed",
          code: "permission_denied",
        },
      ],
    });

    async function openDelivery(
      guestConfigured: boolean | null,
      delivered: typeof status,
    ) {
      const harness = mountChip(guestConfigured, delivered);
      openDrawer(harness, { kind: "chip", key: "" }, "Settings delivery");
      await screen.findByText("Build box", { exact: true });
    }

    it("offers Repair setup, not Retry applying, for a guest that really failed on a 1.0 host", async () => {
      advertiseRepair(0);
      await openDelivery(false, status);

      expect(
        await screen.findByRole("button", { name: "Repair setup" }),
      ).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: "Retry applying" }),
      ).toBeNull();
    });

    it("offers Retry applying for a guest that really failed on a host with the combined retry", async () => {
      advertiseRepair(1);
      await openDelivery(false, status);

      expect(
        await screen.findByRole("button", { name: "Retry applying" }),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Repair setup" })).toBeNull();
    });

    it("offers nothing on a host whose repair version is unknown", async () => {
      await openDelivery(false, status);

      expect(screen.queryByRole("button", { name: "Repair setup" })).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Retry applying" }),
      ).toBeNull();
    });

    it("never offers Repair setup when only an environment item failed and the guest is configured", async () => {
      advertiseRepair(0);
      await openDelivery(true, environmentFailed);
      // The row did read as not applied, so the missing button is the rule's.
      expect(
        (await screen.findAllByText(/Not applied/)).length,
      ).toBeGreaterThan(0);

      expect(screen.queryByRole("button", { name: "Repair setup" })).toBeNull();
    });

    it("never offers Repair setup when only an environment item failed and the guest is unknown", async () => {
      advertiseRepair(0);
      await openDelivery(null, environmentFailed);
      // The row did read as not applied, so the missing button is the rule's.
      expect(
        (await screen.findAllByText(/Not applied/)).length,
      ).toBeGreaterThan(0);

      expect(screen.queryByRole("button", { name: "Repair setup" })).toBeNull();
    });

    it("never offers Repair setup for a guest whose state is unknown", async () => {
      advertiseRepair(0);
      await openDelivery(null, status);

      expect(screen.queryByRole("button", { name: "Repair setup" })).toBeNull();
    });
  });

  it("shows only the drawer's no-access state once history is refused, even with the sandbox cached", async () => {
    const harness = mountTeamPage(poolSource("viewer"), {
      "environment.history": () => {
        throw new Error("Forbidden: no longer a member");
      },
      "environment.status": () => status,
    });
    harness.queryClient.setQueryDefaults(sandboxQueryKeys.listAll(), {
      gcTime: Number.POSITIVE_INFINITY,
    });
    harness.queryClient.setQueryData(sandboxQueryKeys.list({}, "user-me"), {
      sandboxes: [
        sandboxSummaryFixture({
          hostId: HOST_ID,
          displayName: "Build box",
          state: "awake",
          guestConfigured: false,
          failureCode: "envelope-delivery:x",
        }),
      ],
    });
    openDrawer(harness, { kind: "chip", key: "" }, "Settings delivery");

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Couldn't load details.Retry",
    );
    expect(document.body.textContent).not.toMatch(
      /Build box|Claude Code|ANTHROPIC_API_KEY|SBX-|envelope-delivery|not used/,
    );
    expect(harness.paramsOf("environment.status")).toEqual([]);
  });

  it("keeps the raw item key in the diagnostics export only", async () => {
    const harness = mountChip(null, status);
    const user = userEvent.setup();
    openDrawer(harness, { kind: "chip", key: "" }, "Settings delivery");
    await screen.findByText(/not used on sandboxes/);

    await user.click(
      await screen.findByRole("tab", { name: "Export diagnostics" }),
    );
    await user.click(screen.getByRole("button", { name: "Save diagnostics" }));
    const exported = await savedExport();

    expect(JSON.stringify(exported)).toContain("claude:ANTHROPIC_API_KEY");
    expect(JSON.stringify(exported)).toContain("not_used");
  });
});

/**
 * NEW-154-25: the member subject used to reuse the host-apply summary, so a
 * member's drawer read "No hosts yet" — a host claim about a person. Q3 takes
 * the host out of a pending removal's line.
 */
describe("a member's Now", () => {
  it("names the role, since when and who changed it, not what hosts did", async () => {
    const harness = mountTeamPage(poolSource("admin"), {
      "environment.history": () =>
        history({
          // A member's role change is a `put`, as authn commits it.
          entries: [
            {
              at: AT,
              actor: { label: "Ada", tombstoned: false },
              operation: "put",
              outcome: "live",
            },
          ],
          hostStates: [{ ...brokenHost, state: "applied", reason: null }],
        }),
    });
    openDrawer(
      harness,
      { kind: "member", key: "u-2", roleLabel: "Editor" },
      "Member details",
    );

    expect(
      await screen.findByText(`Editor since ${formatted(AT)}, changed by Ada`),
    ).toBeTruthy();
    expect(screen.queryByText("No hosts yet")).toBeNull();
    expect(screen.queryByText("Applied on 1 host")).toBeNull();
    // The summary already carries the time and the actor.
    expect(screen.queryByText(/Last change/)).toBeNull();
  });

  it("claims no role the row did not name", async () => {
    const harness = mountTeamPage(poolSource("admin"), {
      "environment.history": () =>
        history({
          entries: [
            {
              at: AT,
              actor: { label: "Ada", tombstoned: false },
              operation: "put",
              outcome: "live",
            },
          ],
        }),
    });
    openDrawer(harness, { kind: "member", key: "u-2" }, "Member details");

    await screen.findByRole("tab", { name: "Status" });
    expect(screen.queryByText(/since/)).toBeNull();
    expect(screen.queryByText("No hosts yet")).toBeNull();
  });

  it("reads Removing while a removal is pending, and names no host", async () => {
    const harness = mountTeamPage(poolSource("admin"), {
      "environment.history": () =>
        history({
          entries: [
            {
              at: AT,
              actor: { label: "Ada", tombstoned: false },
              operation: "delete",
              outcome: "live",
            },
          ],
          hostStates: [{ ...brokenHost, state: "offline" }],
        }),
    });
    openDrawer(harness, { kind: "member", key: "u-2" }, "Member details");

    expect(await screen.findByText("Removing")).toBeTruthy();
    expect(screen.queryByText(/waiting for/)).toBeNull();
    expect(screen.queryByText("No hosts yet")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open dev-box" })).toBeNull();
  });

  it("says nothing it has not read when the member has no history", async () => {
    const harness = mountTeamPage(poolSource("admin"), {
      "environment.history": () => history({}),
    });
    openDrawer(harness, { kind: "member", key: "u-2" }, "Member details");

    await screen.findByRole("tab", { name: "Status" });
    expect(screen.queryByText("No hosts yet")).toBeNull();
    expect(document.body.textContent).not.toMatch(/unknown/i);
  });

  // The roles notice opens the drawer with no member named, so
  // `environment.history` answers for the whole configuration. A secret
  // removed there is the newest `delete` in that answer, and it says nothing
  // about anyone's membership.
  it("reads another item's removal as no person's, when the subject names none", async () => {
    const harness = mountTeamPage(poolSource("admin"), {
      "environment.history": () =>
        history({
          entries: [
            // The configuration's newest change: a secret was removed.
            {
              at: AT,
              actor: { label: "Ada", tombstoned: false },
              operation: "delete",
              outcome: "live",
            },
          ],
          hostStates: [{ ...brokenHost, state: "applied", reason: null }],
        }),
    });
    openDrawer(
      harness,
      { kind: "member", key: "", roleLabel: null },
      "Member details",
    );

    // The delivery summary, as every keyless subject reads, and no claim that
    // a person is on their way out.
    expect(await screen.findByText("Applied on 1 host")).toBeTruthy();
    expect(screen.queryByText("Removing")).toBeNull();
    expect(document.body.textContent).not.toContain("since");
  });
});

/**
 * NEW-154-21's History sentence. A host destroyed with a cleanup outstanding
 * has no copy left to delete, and the server says so on the event itself:
 * `outcome: "host_destroyed"` with the host as the event's actor (G8's #7382).
 * An older server sends no such outcome, and its events read as they always
 * did.
 */
describe("a destroyed host in History", () => {
  /** The one entry's row in History, where the event's own line is drawn. */
  async function openHistory(
    entry: EnvironmentHistoryResponse["entries"][number],
  ): Promise<HTMLElement> {
    const harness = mountTeamPage(poolSource("admin"), {
      "environment.history": () =>
        history({ entries: [entry], hostStates: [brokenHost] }),
      "environment.secrets.list": () => ({ secrets: [], removed: [] }),
    });
    const user = userEvent.setup();
    openDrawer(harness, { kind: "secret", key: "" }, "Secrets");
    await user.click(await screen.findByRole("tab", { name: "History" }));
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  // The entry authn emits, verbatim from the agreed contract.
  const DESTROYED = {
    at: AT,
    actor: { label: "e2e-sbx-t1", tombstoned: true },
    operation: "secret_cleanup_confirmed",
    outcome: "host_destroyed",
  };

  it("says the destroyed host's copy is gone, in place of the event's codes", async () => {
    const row = await openHistory(DESTROYED);

    expect(row.textContent).toContain(
      "e2e-sbx-t1 was destroyed, so its copy is gone.",
    );
    expect(row.textContent).toContain(formatted(AT));
    // No raw code, and the host is named once: by the sentence, not again
    // on the line under it.
    expect(row.textContent).not.toContain("host_destroyed");
    expect(row.textContent).not.toContain("secret_cleanup_confirmed");
    expect(row.textContent.match(/e2e-sbx-t1/g)).toHaveLength(1);
  });

  it("keeps the generic event for a server that reports no destruction", async () => {
    const row = await openHistory({ ...DESTROYED, outcome: "succeeded" });

    expect(row.textContent).toContain("secret_cleanup_confirmed · succeeded");
    expect(row.textContent).not.toContain("was destroyed");
    expect(row.textContent).toContain(`e2e-sbx-t1 · ${formatted(AT)}`);
  });

  it("names no host when the outcome arrives with no actor to name", async () => {
    const row = await openHistory({ ...DESTROYED, actor: null });

    expect(row.textContent).not.toContain("was destroyed");
    expect(row.textContent).toContain(
      "secret_cleanup_confirmed · host_destroyed",
    );
    expect(row.textContent).toContain("Traycer");
  });
});
