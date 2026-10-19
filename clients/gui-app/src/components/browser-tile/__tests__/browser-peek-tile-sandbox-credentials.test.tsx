import "../../../../__tests__/test-browser-apis";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { hostListItemToDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { renderPeekTile } from "@/components/browser-tile/__tests__/browser-peek-tile-render";
import {
  FakeStreamClient,
  PEEK_NODE,
  clearScreencastOwner,
  hostStreamClientForWithAuthModule,
  liveStream as fixtureLiveStream,
  registeredHostsModule,
  runnerOpenExternalLinkModule,
  streamAuthRevalidatorModule,
  tabHostIdModule,
  tileRoleRunnerHostModule,
  type FakeStreamSession,
} from "@/components/browser-tile/__tests__/browser-peek-tile-stream-fixture";
import { BrowserPeekTile } from "@/components/browser-tile/browser-peek-tile";
import { SANDBOX_CREDENTIALS_REFUSED } from "@/components/settings/host-scope/host-option-model";

const toasts = vi.hoisted(() => ({ warning: vi.fn() }));

const hookState = vi.hoisted(() => ({
  streamClient: null as FakeStreamClient | null,
  visible: true,
  /** The tile's host row, which decides whether it is a sandbox. */
  entry: null as HostDirectoryEntry | null,
}));

vi.mock("@/providers/use-runner-host", () => tileRoleRunnerHostModule());
vi.mock("@/hooks/runner/use-open-external-link-mutation", () =>
  runnerOpenExternalLinkModule(),
);
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { warning: toasts.warning }),
}));
vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () =>
  tabHostIdModule(),
);
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => hookState.entry,
}));
vi.mock("@/hooks/auth/use-registered-hosts-query", () =>
  registeredHostsModule(),
);
vi.mock("@/hooks/host/use-host-stream-client-for", () =>
  hostStreamClientForWithAuthModule(hookState),
);
vi.mock("@/lib/host/stream-auth-revalidator", () =>
  streamAuthRevalidatorModule(),
);

const SIGN_IN_URL = "https://u:p@site.test";

function remoteEntry(kind: "personal" | "sandbox"): HostDirectoryEntry {
  const item: HostListItem = {
    hostId: PEEK_NODE.hostId,
    displayName: "remote",
    platform: "linux",
    kind,
    publicKey: "pk",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatePolicy: "manual",
    status: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.5.0",
      lastSeenAt: null,
    },
    ...(kind === "sandbox"
      ? {
          sandboxState: "awake" as const,
          sandboxFrozen: false,
          profile: "agent" as const,
        }
      : {}),
  };
  return hostListItemToDirectoryEntry(item, "wss://relay.example.test");
}

function liveStream(): FakeStreamSession {
  return fixtureLiveStream(hookState);
}

function framesOfKind(
  stream: FakeStreamSession,
  kind: string,
): Array<Record<string, unknown>> {
  return stream.sentFrames.filter((frame) => frame.kind === kind);
}

function renderTile(): void {
  renderPeekTile(
    <BrowserPeekTile
      scope={{ kind: "epic", epicId: "epic-1" }}
      visible={hookState.visible}
      onConvertToPip={() => {}}
      onRequestNewTab={null}
      onRequestCloseTab={null}
      node={PEEK_NODE}
      completeMeans="ended"
    />,
  );
}

function submitAddress(url: string): void {
  const input = screen.getByRole<HTMLInputElement>("textbox", {
    name: "Browser address",
  });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: url } });
  const form = input.closest("form");
  if (form === null) {
    throw new Error("the address bar is not inside a form");
  }
  fireEvent.submit(form);
}

describe("BrowserPeekTile address bar on a sandbox host", () => {
  beforeEach(() => {
    hookState.visible = true;
    hookState.streamClient = new FakeStreamClient(true);
    hookState.entry = null;
    toasts.warning.mockClear();
    clearScreencastOwner();
  });

  afterEach(() => {
    cleanup();
    clearScreencastOwner();
  });

  it("toasts the sandbox refusal and sends no navigation for a URL with a sign-in", () => {
    hookState.entry = remoteEntry("sandbox");
    renderTile();
    const stream = liveStream();

    submitAddress(SIGN_IN_URL);
    act(() => {
      stream.emit(
        { kind: "armed", hasBinaryPayload: false, armEpoch: 1 },
        null,
      );
    });

    expect(toasts.warning).toHaveBeenCalledTimes(1);
    expect(toasts.warning).toHaveBeenCalledWith(SANDBOX_CREDENTIALS_REFUSED, {
      description: "Remove the sign-in from this URL to open it here.",
    });
    // Nothing was requested: not a navigation, and not even the arm that a
    // navigation from a cold tile would have made.
    expect(framesOfKind(stream, "navigate")).toEqual([]);
    expect(framesOfKind(stream, "arm")).toEqual([]);
  });

  it("still navigates a sandbox's tile to a plain URL", () => {
    hookState.entry = remoteEntry("sandbox");
    renderTile();
    const stream = liveStream();

    submitAddress("https://site.test/page");
    act(() => {
      stream.emit(
        { kind: "armed", hasBinaryPayload: false, armEpoch: 1 },
        null,
      );
    });

    expect(toasts.warning).not.toHaveBeenCalled();
    const navigations = framesOfKind(stream, "navigate");
    expect(navigations).toHaveLength(1);
    const url = navigations[0]?.url;
    expect(typeof url === "string" && url.includes("site.test/page")).toBe(
      true,
    );
  });
});

describe("BrowserPeekTile address bar on a personal host", () => {
  beforeEach(() => {
    hookState.visible = true;
    hookState.streamClient = new FakeStreamClient(true);
    toasts.warning.mockClear();
    clearScreencastOwner();
  });

  afterEach(() => {
    cleanup();
    clearScreencastOwner();
  });

  it.each([
    ["a remote personal host", () => remoteEntry("personal")],
    ["this computer's host", () => mockLocalHostEntry],
  ])("sends the navigation for a URL with a sign-in on %s", (_name, entry) => {
    hookState.entry = entry();
    renderTile();
    const stream = liveStream();

    submitAddress(SIGN_IN_URL);
    act(() => {
      stream.emit(
        { kind: "armed", hasBinaryPayload: false, armEpoch: 1 },
        null,
      );
    });

    expect(toasts.warning).not.toHaveBeenCalled();
    const navigations = framesOfKind(stream, "navigate");
    expect(navigations).toHaveLength(1);
    const url = navigations[0]?.url;
    expect(typeof url === "string" && url.includes("u:p@site.test")).toBe(true);
  });

  it("sends the navigation when the tile has no host row yet", () => {
    hookState.entry = null;
    renderTile();
    const stream = liveStream();

    submitAddress(SIGN_IN_URL);
    act(() => {
      stream.emit(
        { kind: "armed", hasBinaryPayload: false, armEpoch: 1 },
        null,
      );
    });

    expect(toasts.warning).not.toHaveBeenCalled();
    expect(framesOfKind(stream, "navigate")).toHaveLength(1);
  });
});
