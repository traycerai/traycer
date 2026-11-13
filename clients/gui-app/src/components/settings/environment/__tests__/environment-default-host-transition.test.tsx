import { useEffect, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EnvironmentPickUpkeep } from "@/components/settings/environment-picker";
import { PersonalPageFrame } from "@/components/settings/personal/personal-page-frame";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import type { EnvironmentStatusResponseV12 } from "@traycer/protocol/host/environment-schemas";

const facts = vi.hoisted(
  (): {
    statuses: Map<string, EnvironmentStatusResponseV12 | null>;
    mounts: string[];
    remote: boolean;
    registered: boolean;
  } => ({ statuses: new Map(), mounts: [], remote: false, registered: true }),
);
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const { useEffectiveHostId } =
    await import("@/hooks/host/use-effective-host-id");
  return {
    WINDOW_HOST_SELECTION: {},
    useHostScopeFor: () => {
      const hostId = useEffectiveHostId();
      const hosts = [
        hostScopeOptionFixture({
          hostId: "a",
          isLocalMachine: !facts.remote,
          registered: facts.registered,
        }),
        hostScopeOptionFixture({ hostId: "b" }),
      ];
      return hostScopeFixture({
        hosts,
        activeHostId: hostId,
        host: hosts.find((host) => host.hostId === hostId) ?? null,
      });
    },
  };
});
vi.mock("@/hooks/environment/use-registered-host-environment-statuses", () => ({
  useRegisteredHostEnvironmentStatuses: () => facts.statuses,
}));
vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersions: () => new Map(),
}));
vi.mock(
  "@/components/settings/environment/configuration-source-boundary",
  () => ({
    ConfigurationSourceBoundary: (props: { readonly children: ReactNode }) =>
      props.children,
  }),
);
vi.mock("@/hooks/environment/team/use-team-viewing-host", () => ({
  useTeamViewingHost: () => ({ client: null, viewingHost: null }),
}));

function Editor(): ReactNode {
  const hostId = useSelectionAuthorityStore((state) => state.effectiveHostId);
  useEffect(() => {
    facts.mounts.push(hostId ?? "none");
  }, [hostId]);
  return <button>Edit configuration</button>;
}

function Settings(props: {
  readonly section: "skills" | "mcp-servers";
}): ReactNode {
  return (
    <>
      <EnvironmentPickUpkeep />
      <PersonalPageFrame section={props.section}>
        <Editor />
      </PersonalPageFrame>
    </>
  );
}

afterEach(() => {
  cleanup();
  facts.mounts = [];
  facts.remote = false;
  facts.registered = true;
  facts.statuses = new Map();
  useSelectionAuthorityStore.getState().reset();
  useSettingsEnvironmentPickStore.setState({
    pick: null,
    defaultHostId: null,
    defaultPick: { kind: "unresolved" },
  });
});

it.each<"skills" | "mcp-servers">(["skills", "mcp-servers"])(
  "never mounts %s editors for an unanswered new window host",
  (section) => {
    facts.statuses = new Map([["a", environmentStatusFixture({})]]);
    useSelectionAuthorityStore.setState({ effectiveHostId: "a" });
    const queryClient = new QueryClient();
    const view = render(
      <QueryClientProvider client={queryClient}>
        <Settings section={section} />
      </QueryClientProvider>,
    );
    expect(facts.mounts).toEqual(["a"]);
    act(() => useSelectionAuthorityStore.setState({ effectiveHostId: "b" }));
    expect(screen.getByTestId("environment-source-loading")).toBeTruthy();
    expect(facts.mounts).toEqual(["a"]);
    view.unmount();
    // A closed Settings surface must not reuse A's last default on reopening.
    useSettingsEnvironmentPickStore
      .getState()
      .setDefaultPick({ kind: "personal" }, "a");
    const reopened = render(
      <QueryClientProvider client={queryClient}>
        <Settings section={section} />
      </QueryClientProvider>,
    );
    expect(facts.mounts).toEqual(["a"]);
    facts.statuses = new Map([["b", environmentStatusFixture({})]]);
    reopened.rerender(
      <QueryClientProvider client={queryClient}>
        <Settings section={section} />
      </QueryClientProvider>,
    );
    expect(facts.mounts).toEqual(["a", "b"]);
  },
);

it("waits for a remote computer's registry row and status before mounting editors", () => {
  facts.remote = true;
  facts.registered = false;
  useSelectionAuthorityStore.setState({ effectiveHostId: "a" });
  const queryClient = new QueryClient();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Settings section="skills" />
    </QueryClientProvider>,
  );
  expect(useSettingsEnvironmentPickStore.getState().defaultPick).toEqual({
    kind: "unresolved",
  });
  expect(facts.mounts).toEqual([]);
  facts.registered = true;
  view.rerender(
    <QueryClientProvider client={queryClient}>
      <Settings section="skills" />
    </QueryClientProvider>,
  );
  expect(facts.mounts).toEqual([]);
  facts.statuses = new Map([["a", environmentStatusFixture({})]]);
  view.rerender(
    <QueryClientProvider client={queryClient}>
      <Settings section="skills" />
    </QueryClientProvider>,
  );
  expect(useSettingsEnvironmentPickStore.getState().defaultPick).toEqual({
    kind: "personal",
  });
  expect(facts.mounts).toEqual(["a"]);
});
