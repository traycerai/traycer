/**
 * "Use <host>" takes a stage off a composer, and the chip then names that host.
 * The two must say the same name, so each case reads the action, presses it,
 * and compares it with what the real host switcher then shows.
 */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import { HostSwitcher } from "@/components/settings/host-scope/host-switcher";
import type { HostSwitcherComposerMode } from "@/components/settings/host-scope/host-switcher";
import { NO_HOST_OPTION_REFUSALS } from "@/components/settings/host-scope/host-option-model";
import {
  buildHostScopeOptions,
  findHostOption,
  type HostScopeOption,
} from "@/components/settings/host-scope/host-scope-model";
import { useStageFallbackHostLine } from "@/hooks/sandboxes/use-stage-fallback-host-line";
import {
  useStagedSandbox,
  useStagedSandboxStore,
  type StagedSandboxTarget,
} from "@/stores/composer/staged-sandbox-store";

// The merged host list is built by the real `buildHostScopeOptions` from real
// directory entries and registry rows; only the hook that gathers those inputs
// from the app's queries is replaced.
const hostList = vi.hoisted(() => ({
  hosts: [] as readonly HostScopeOption[],
  /** The directory those hosts were built from, as its own list reads it. */
  directory: [] as readonly HostDirectoryEntry[],
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: hostList.directory }),
}));
vi.mock("@/components/settings/host-scope/use-host-options", () => ({
  useHostOptions: () => ({ hosts: hostList.hosts }),
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => null,
}));

const SURFACE = "landing:window-test";
const LOCAL_HOST = "local-host";
const REMOTE_HOST = "remote-host";
const BLANK_HOST = "blank-host";

const STAGE: StagedSandboxTarget = {
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
  name: "",
  wakeString: null,
};

function directoryEntry(
  hostId: string,
  label: string,
  kind: HostDirectoryEntry["kind"],
): HostDirectoryEntry {
  return {
    hostId,
    label,
    kind,
    websocketUrl: `wss://relay.example/${hostId}`,
    version: "1.4.2",
    transportDialability: "dialable",
  };
}

function registryRow(hostId: string, displayName: string | null): HostListItem {
  return {
    hostId,
    displayName,
    platform: "darwin-arm64",
    kind: "personal",
    publicKey: "pk",
    createdAt: "2026-01-01T00:00:00Z",
    updatePolicy: "manual",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.4.2",
      lastSeenAt: "2026-01-01T00:00:00Z",
    },
  };
}

function optionsOf(
  directory: readonly HostDirectoryEntry[],
  registry: readonly HostListItem[],
): readonly HostScopeOption[] {
  return buildHostScopeOptions({
    leases: [],
    authorityAttached: false,
    directory,
    registry,
    localHostId: LOCAL_HOST,
    activeHostId: LOCAL_HOST,
    localService: undefined,
    localPlatform: null,
    hasLiveSession: () => false,
    localHostSettingUp: false,
    localHostTerminalRunNote: null,
    sandboxes: null,
    nowMs: 0,
  });
}

function composerMode(stagedLabel: string | null): HostSwitcherComposerMode {
  return {
    viewerUserId: null,
    inThisTask: null,
    subLinesFor: () => [],
    tagFor: () => null,
    newRows: [],
    rememberedConfigurationKey: null,
    stagedConfigurationKey: null,
    hostPickRequests: 0,
    stagedLabel,
    stagedBusy: false,
    onPickHost: () => undefined,
    onPickNew: () => undefined,
    onOpenShape: () => undefined,
    onManage: () => undefined,
  };
}

/** A composer's host chip with a stage on it, and the stage's way off. */
function Composer(props: { readonly hostId: string }): ReactNode {
  const action = useStageFallbackHostLine(props.hostId, null);
  const staged = useStagedSandbox(SURFACE) !== null;
  const selected = findHostOption(hostList.hosts, props.hostId);
  return (
    <>
      {staged ? (
        <button
          type="button"
          onClick={() => useStagedSandboxStore.getState().clear(SURFACE)}
        >
          {action}
        </button>
      ) : null}
      <HostSwitcher
        refusalByHostId={NO_HOST_OPTION_REFUSALS}
        inertExceptHostId={null}
        hosts={hostList.hosts}
        selected={selected}
        activeHostId={LOCAL_HOST}
        onSelect={() => undefined}
        action={null}
        surface="field"
        intent="pin"
        disabled={false}
        isLoading={false}
        listsFailed={false}
        onRetryLists={() => undefined}
        updateViewForHost={null}
        environmentLabelForHost={null}
        composer={composerMode(staged ? "New Personal sandbox" : null)}
      />
    </>
  );
}

function chipText(): string {
  return screen.getByTestId("settings-host-switcher").textContent;
}

/**
 * Stages a sandbox on a composer chip for `hostId`, reads the action that takes
 * it off, presses it, and reads the chip.
 */
function pressAction(hostId: string): {
  readonly action: string;
  readonly chip: string;
} {
  useStagedSandboxStore.getState().stage(SURFACE, STAGE);
  render(<Composer hostId={hostId} />);
  expect(chipText()).toContain("New Personal sandbox");
  const button = screen.getByRole("button", { name: /^Use / });
  const action = button.textContent;
  fireEvent.click(button);
  return { action, chip: chipText() };
}

beforeEach(() => {
  useStagedSandboxStore.setState({ bySurface: {} });
  hostList.directory = [
    directoryEntry(LOCAL_HOST, "Hardiks-MacBook-Pro---Traycer.local", "local"),
    directoryEntry(REMOTE_HOST, "directory-label-remote", "remote"),
    directoryEntry(BLANK_HOST, BLANK_HOST, "remote"),
  ];
  hostList.hosts = optionsOf(hostList.directory, [
    registryRow(REMOTE_HOST, "Build Server"),
    registryRow(BLANK_HOST, null),
  ]);
});

afterEach(cleanup);

describe("the action that takes a stage off a composer", () => {
  it("names this computer as its chip does, not by the machine's own name", () => {
    const { action, chip } = pressAction(LOCAL_HOST);

    expect(action).toBe("Use This computer");
    expect(action).toBe(`Use ${chip}`);
  });

  it("names a remote host by the registry's name, not the directory's label", () => {
    const { action, chip } = pressAction(REMOTE_HOST);

    expect(action).toBe("Use Build Server");
    expect(action).toBe(`Use ${chip}`);
  });

  it("says Use another host for a host the list does not have", () => {
    const { action } = pressAction("unlisted-host");

    expect(action).toBe("Use another host");
    expect(action).not.toMatch(/Local|Unavailable/);
  });

  it("says Use another host for a host with no name of its own", () => {
    const { action } = pressAction(BLANK_HOST);

    expect(action).toBe("Use another host");
  });
});
