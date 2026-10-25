import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hostOptionsFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { ComposerStagedSurfaceKeyProvider } from "@/components/composer/composer-staged-sandbox-context";
import { TerminalAccountFirstMention } from "@/components/home/pickers/terminal-account-first-mention";
import { useStagedSandboxStore } from "@/stores/composer/staged-sandbox-store";
import { useTerminalAccountMentionStore } from "@/stores/onboarding/terminal-account-mention-store";

// The fleet's rows are the boundary: which machine is this one, and what the
// run target is called.
const fleet = vi.hoisted(() => ({ hosts: [] as HostScopeOption[] }));
vi.mock("@/components/settings/host-scope/use-host-options", () => ({
  useHostOptions: () => hostOptionsFixture({ hosts: fleet.hosts }),
}));

const SENTENCE =
  "This computer's own sign-in, which stays on this computer. Link a plan to use one everywhere.";
const PERSIST_NAME = "traycer-gui-app:terminal-account-mention";

function resetStore(): void {
  window.localStorage.clear();
  fleet.hosts = [];
  useTerminalAccountMentionStore.setState({ explained: false });
}

function explained(): boolean {
  return useTerminalAccountMentionStore.getState().explained;
}

describe("<TerminalAccountFirstMention />", () => {
  beforeEach(resetStore);
  afterEach(() => {
    cleanup();
    resetStore();
  });

  it("says what the Terminal account is when the picker names one and it has not been said", () => {
    render(<TerminalAccountFirstMention named runTargetHostId={null} />);

    expect(
      screen.getByTestId("terminal-account-first-mention").textContent,
    ).toBe(SENTENCE);
    // Shown is not said: it stays until the picker goes away.
    expect(explained()).toBe(false);
  });

  it("shows nothing when the picker does not name a Terminal account", () => {
    render(
      <TerminalAccountFirstMention named={false} runTargetHostId={null} />,
    );

    expect(screen.queryByTestId("terminal-account-first-mention")).toBeNull();
  });

  it("shows nothing once it has been said on this desktop", () => {
    useTerminalAccountMentionStore.setState({ explained: true });
    render(<TerminalAccountFirstMention named runTargetHostId={null} />);

    expect(screen.queryByTestId("terminal-account-first-mention")).toBeNull();
  });

  it("counts it as said when the picker that showed it goes away, and a remount shows nothing", () => {
    const first = render(
      <TerminalAccountFirstMention named runTargetHostId={null} />,
    );
    expect(screen.getByTestId("terminal-account-first-mention")).toBeTruthy();
    expect(explained()).toBe(false);

    first.unmount();

    expect(explained()).toBe(true);
    render(<TerminalAccountFirstMention named runTargetHostId={null} />);
    expect(screen.queryByTestId("terminal-account-first-mention")).toBeNull();
  });

  it("remembers it was said across a reload", async () => {
    render(
      <TerminalAccountFirstMention named runTargetHostId={null} />,
    ).unmount();
    const persisted = window.localStorage.getItem(PERSIST_NAME);
    if (persisted === null) throw new Error("nothing was persisted");

    useTerminalAccountMentionStore.setState({ explained: false });
    window.localStorage.setItem(PERSIST_NAME, persisted);
    await useTerminalAccountMentionStore.persist.rehydrate();

    expect(explained()).toBe(true);
    expect(JSON.parse(persisted)).toMatchObject({ state: { explained: true } });
  });

  it("does not mark it when it was never shown", () => {
    const unnamed = render(
      <TerminalAccountFirstMention named={false} runTargetHostId={null} />,
    );
    unnamed.unmount();
    expect(explained()).toBe(false);

    // Nothing said was written either: a later picker that does name it
    // still has the sentence to say.
    expect(window.localStorage.getItem(PERSIST_NAME)).not.toContain(
      '"explained":true',
    );
    render(<TerminalAccountFirstMention named runTargetHostId={null} />);
    expect(screen.getByTestId("terminal-account-first-mention")).toBeTruthy();
  });

  describe("names the host the run goes to", () => {
    const THIS_COMPUTER = hostScopeOptionFixture({
      hostId: "laptop",
      name: "windows-test-machine",
      isLocalMachine: true,
    });
    const SANDBOX = hostScopeOptionFixture({
      hostId: "sbx-p1",
      name: "e2e-sbx-p1",
      isLocalMachine: false,
      isActive: false,
      kind: "sandbox",
    });

    it("says the sandbox's name in place of this computer", () => {
      fleet.hosts = [THIS_COMPUTER, SANDBOX];
      render(<TerminalAccountFirstMention named runTargetHostId="sbx-p1" />);

      expect(
        screen.getByTestId("terminal-account-first-mention").textContent,
      ).toBe(
        "e2e-sbx-p1's own sign-in, which stays on e2e-sbx-p1. Link a plan to use one everywhere.",
      );
    });

    it("says this computer when the run goes to the machine the app is on", () => {
      fleet.hosts = [THIS_COMPUTER, SANDBOX];
      render(<TerminalAccountFirstMention named runTargetHostId="laptop" />);

      expect(
        screen.getByTestId("terminal-account-first-mention").textContent,
      ).toBe(SENTENCE);
    });
  });
});

describe("<TerminalAccountFirstMention /> on a composer with a sandbox staged", () => {
  const SURFACE = "landing:window-test";

  beforeEach(() => {
    resetStore();
    useStagedSandboxStore.setState({ bySurface: {} });
  });
  afterEach(() => {
    cleanup();
    resetStore();
    useStagedSandboxStore.setState({ bySurface: {} });
  });

  function stageNamed(name: string): void {
    useStagedSandboxStore.getState().stage(SURFACE, {
      kind: "new",
      configuration: { kind: "personal" },
      shape: {
        os: "linux",
        cpus: 2,
        memoryMb: 4096,
        diskMb: null,
        region: "us-east",
        idleMinutes: 30,
        destroyAfterRestingMinutes: null,
      },
      name,
      wakeString: null,
    });
  }

  function renderIn(surfaceKey: string | null) {
    return render(
      <ComposerStagedSurfaceKeyProvider surfaceKey={surfaceKey}>
        <TerminalAccountFirstMention named runTargetHostId={null} />
      </ComposerStagedSurfaceKeyProvider>,
    );
  }

  it("names the staged sandbox in place of this computer", () => {
    stageNamed("e2e-sbx-p1");
    renderIn(SURFACE);

    expect(
      screen.getByTestId("terminal-account-first-mention").textContent,
    ).toBe(
      "e2e-sbx-p1's own sign-in, which stays on e2e-sbx-p1. Link a plan to use one everywhere.",
    );
  });

  it("still names this computer when nothing is staged under the surface", () => {
    renderIn(SURFACE);

    expect(
      screen.getByTestId("terminal-account-first-mention").textContent,
    ).toBe(SENTENCE);
  });

  it("still names this computer outside a composer that stages", () => {
    stageNamed("e2e-sbx-p1");
    renderIn(null);

    expect(
      screen.getByTestId("terminal-account-first-mention").textContent,
    ).toBe(SENTENCE);
  });
});
