import "../../../../../__tests__/test-browser-apis";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@uiw/react-codemirror";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { settleProcessHostRpcTierPlan } from "@traycer-clients/shared/host-client/host-rpc-routing";
import { poolEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { EnvironmentHostRecordV12 } from "@traycer/protocol/host/environment/contracts";
import { TeamGuide } from "@/components/settings/environment/team-guide";
import type { HostRpcRegistry } from "@/lib/host";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import {
  negotiateMethodsOn,
  reachableHost,
  teamEnvironments,
} from "./mcp-skills-test-support";
import {
  hostIdsOf,
  mountTeamPageOnPoolBuild,
  poolSource,
  requireTeamHostClient,
  resetTeamPageHarness,
  teamHostBoundary,
} from "./team-configuration-test-support";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

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
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null ? null : requireTeamHostClient(),
}));

// The tier plan is frozen per process from the build; this file's build has a pool.
beforeAll(() => {
  settleProcessHostRpcTierPlan(poolEntry);
});

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  resetNegotiatedManifests();
  useSettingsEnvironmentPickStore.setState({ pick: null });
});

const V10 = { major: 1, minor: 0 };

/** What the pool advertised at its handshake. */
function poolAdvertises(writes: boolean): void {
  negotiateMethodsOn(POOL_HOST_ID, {
    "environment.configuration.guide.get": { major: 1, minor: 1 },
    ...(writes ? { "environment.configuration.guide.set": V10 } : {}),
  });
}

const UNSET_LINE =
  "Acme's agents use the default selection guide until someone saves one.";

function handlers(options: {
  readonly hosts: readonly EnvironmentHostRecordV12[];
  readonly guide: MockHandlerMap<HostRpcRegistry>["environment.configuration.guide.get"];
}): MockHandlerMap<HostRpcRegistry> {
  return {
    "environment.configuration.guide.get": options.guide,
    "environment.configuration.guide.set": () => ({ outcome: "set" as const }),
    "environment.host.list": () => ({ hosts: [...options.hosts] }),
    "environment.list": () => teamEnvironments,
  };
}

function replaceText(text: string): void {
  const input = document.querySelector<HTMLElement>(
    "[data-testid='team-guide-input']",
  );
  if (input === null) throw new Error("guide editor not rendered");
  act(() => {
    const view = EditorView.findFromDOM(input);
    if (view === null) throw new Error("no CodeMirror view");
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
    });
  });
}

describe("TeamGuide when the team's room holds no guide yet", () => {
  it("says agents use the default, and opens an editor on empty text that saves against the unset revision", async () => {
    poolAdvertises(true);
    const harness = mountTeamPageOnPoolBuild(
      poolSource("editor"),
      handlers({
        hosts: [reachableHost],
        guide: () => ({ outcome: "unset" as const, revision: "rev-empty" }),
      }),
    );
    render(<TeamGuide />, { wrapper: harness.Wrapper });

    const line = await screen.findByRole("status");
    expect(line.textContent).toBe(`${UNSET_LINE}Write one`);
    await userEvent.click(screen.getByRole("button", { name: "Write one" }));
    expect(screen.queryByText(UNSET_LINE)).toBeNull();
    replaceText("Prefer sonnet");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.guide.set")).toEqual([
        {
          environmentId: "env-a",
          text: "Prefer sonnet",
          revision: "rev-empty",
        },
      ]);
    });
  });

  it("offers a viewer no way to write one", async () => {
    poolAdvertises(true);
    const harness = mountTeamPageOnPoolBuild(
      poolSource("viewer"),
      handlers({
        hosts: [reachableHost],
        guide: () => ({ outcome: "unset" as const, revision: "rev-empty" }),
      }),
    );
    render(<TeamGuide />, { wrapper: harness.Wrapper });

    const line = await screen.findByRole("status");
    expect(line.textContent).toBe(UNSET_LINE);
    expect(screen.queryByRole("button", { name: "Write one" })).toBeNull();
  });

  it("lets an editor write one with no host running the team, since the pool takes the save", async () => {
    poolAdvertises(true);
    const harness = mountTeamPageOnPoolBuild(
      poolSource("editor"),
      handlers({
        hosts: [],
        guide: () => ({ outcome: "unset" as const, revision: "rev-empty" }),
      }),
    );
    render(<TeamGuide />, { wrapper: harness.Wrapper });

    await userEvent.click(
      await screen.findByRole("button", { name: "Write one" }),
    );
    replaceText("Prefer sonnet");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(harness.paramsOf("environment.configuration.guide.set")).toEqual([
        {
          environmentId: "env-a",
          text: "Prefer sonnet",
          revision: "rev-empty",
        },
      ]);
    });
    expect(hostIdsOf(harness, "environment.configuration.guide.set")).toEqual([
      POOL_HOST_ID,
    ]);
  });

  it("offers an editor no way to write one when the pool does not advertise the save", async () => {
    poolAdvertises(false);
    const harness = mountTeamPageOnPoolBuild(
      poolSource("editor"),
      handlers({
        hosts: [],
        guide: () => ({ outcome: "unset" as const, revision: "rev-empty" }),
      }),
    );
    render(<TeamGuide />, { wrapper: harness.Wrapper });

    const line = await screen.findByRole("status");
    expect(line.textContent).toBe(UNSET_LINE);
    expect(screen.queryByRole("button", { name: "Write one" })).toBeNull();
  });
});

describe("TeamGuide on a build with a server pool and no host running the team", () => {
  it("shows the guide text read from the pool, read-only when the pool does not advertise the save, with no needs-host line", async () => {
    poolAdvertises(false);
    const harness = mountTeamPageOnPoolBuild(
      poolSource("editor"),
      handlers({
        hosts: [],
        guide: () => ({
          outcome: "ok" as const,
          text: "Prefer sonnet",
          revision: "rev-1",
        }),
      }),
    );
    useSelectionAuthorityStore.getState().reset();
    teamHostBoundary.client =
      requireTeamHostClient().createRequesterForHostId(null);
    expect(useSelectionAuthorityStore.getState().effectiveHostId).toBeNull();
    expect(requireTeamHostClient().getActiveHostId()).toBeNull();
    render(<TeamGuide />, { wrapper: harness.Wrapper });

    await waitFor(() => {
      expect(
        document.querySelector("[data-testid='team-guide-read-only']")
          ?.textContent,
      ).toContain("Prefer sonnet");
    });
    expect(screen.queryByText(/The guide needs a host/)).toBeNull();
    // The guide came from the pool, so the page names no host and offers no
    // pick: there is none to make.
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText("Pick a host")).toBeNull();
    expect(
      new Set(hostIdsOf(harness, "environment.configuration.guide.get")),
    ).toEqual(new Set([POOL_HOST_ID]));
  });

  it("offers the guide's editor with no host when the pool advertises the save", async () => {
    poolAdvertises(true);
    const harness = mountTeamPageOnPoolBuild(
      poolSource("editor"),
      handlers({
        hosts: [],
        guide: () => ({
          outcome: "ok" as const,
          text: "Prefer sonnet",
          revision: "rev-1",
        }),
      }),
    );
    render(<TeamGuide />, { wrapper: harness.Wrapper });

    await waitFor(() => {
      expect(
        document.querySelector("[data-testid='team-guide-input']"),
      ).not.toBeNull();
    });
    expect(screen.queryByText(/The guide needs a host/)).toBeNull();
  });

  it("says the read failed, with Retry and no host pick, when the pool predates the guide read", async () => {
    let old = true;
    const harness = mountTeamPageOnPoolBuild(
      poolSource("editor"),
      handlers({
        hosts: [],
        guide: () => {
          if (old) {
            throw new HostRpcError({
              code: "E_HOST_UNSUPPORTED",
              message: "This host does not support the guide.",
              requestId: "req-unsupported",
              method: "environment.configuration.guide.get",
              fatalDetails: {
                code: "E_HOST_UNSUPPORTED",
                reason: "This host does not support the guide.",
                incompatibleMethods: null,
                upgradeGuidance: {
                  clientShouldUpgrade: false,
                  hostShouldUpgrade: true,
                },
              },
            });
          }
          return { outcome: "ok" as const, text: "Back", revision: "rev-1" };
        },
      }),
    );
    render(<TeamGuide />, { wrapper: harness.Wrapper });

    expect(
      await screen.findByText("Couldn't read Acme's selection guide."),
    ).toBeTruthy();
    expect(screen.queryByText(/The guide needs a host/)).toBeNull();
    old = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(
        document.querySelector("[data-testid='team-guide-read-only']")
          ?.textContent,
      ).toContain("Back");
    });
  });
});
