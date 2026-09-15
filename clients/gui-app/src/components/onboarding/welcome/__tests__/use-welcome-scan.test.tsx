import { act, cleanup, renderHook } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type {
  SessionImportCandidate,
  SessionImportGroup,
} from "@traycer/protocol/host/session-import/candidate";
import type {
  SessionImportScanCallbacks,
  SessionImportScanClientOptions,
} from "@traycer-clients/shared/host-transport/session-import-scan-client";

/**
 * The real `useWelcomeScan` → `useSessionImportScan` → reducer chain over a
 * recording scan client: what matters is WHICH roster each client is opened
 * with, and when one is opened at all.
 */
interface ScanClientHarness {
  readonly opened: Array<ReadonlyArray<GuiHarnessId> | null>;
  callbacks: SessionImportScanCallbacks | null;
  readonly close: Mock<() => void>;
}

const scanClient = vi.hoisted((): ScanClientHarness => ({
  opened: [],
  callbacks: null,
  close: vi.fn(),
}));

vi.mock(
  "@traycer-clients/shared/host-transport/session-import-scan-client",
  () => ({
    SessionImportScanClient: class {
      constructor(options: SessionImportScanClientOptions) {
        scanClient.opened.push(options.providers);
        scanClient.callbacks = options.callbacks;
      }

      close(): void {
        scanClient.close();
      }
    },
  }),
);

const stream = vi.hoisted(() => ({
  client: { stream: "test" } as object | null,
  hostId: "host-a" as string | null,
  support: "supported" as "supported" | "unsupported" | "unknown" | null,
}));

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => stream.client,
  useStreamHostId: () => stream.hostId,
  useStreamMethodSupportFor: () => stream.support,
}));

import { useWelcomeScan } from "@/components/onboarding/welcome/use-welcome-scan";

function session(nativeSessionId: string): SessionImportCandidate {
  return {
    harness: "claude",
    nativeSessionId,
    title: nativeSessionId,
    firstPrompt: null,
    createdAt: 1,
    updatedAt: 1,
    messageCount: null,
    hasSubagents: false,
    state: { kind: "importable" },
  };
}

function folderGroup(
  sessions: ReadonlyArray<SessionImportCandidate>,
): SessionImportGroup {
  return {
    location: { kind: "folder", path: "/repo/a", workspaceId: null },
    gitBacked: true,
    sessions: [...sessions],
  };
}

function renderScan(initial: ReadonlyArray<ProviderId>) {
  return renderHook(
    (props: { readonly enabledProviderIds: ReadonlyArray<ProviderId> }) =>
      useWelcomeScan({
        open: true,
        enabledProviderIds: props.enabledProviderIds,
      }),
    { initialProps: { enabledProviderIds: initial } },
  );
}

describe("useWelcomeScan", () => {
  beforeEach(() => {
    scanClient.opened.length = 0;
    scanClient.callbacks = null;
    scanClient.close.mockReset();
    stream.client = { stream: "test" };
    stream.hostId = "host-a";
    stream.support = "supported";
  });

  afterEach(() => {
    cleanup();
  });

  it("scans the session-capable subset of the enabled providers, sorted", () => {
    const { result } = renderScan(["traycer", "claude-code", "cursor"]);
    expect(result.current.providers).toEqual(["claude"]);
    expect(result.current.eligible).toBe(true);
    expect(result.current.support).toBe("supported");
    expect(scanClient.opened).toEqual([["claude"]]);
  });

  it("restarts the scan on a roster change, and keeps it across an unchanged one", () => {
    const { result, rerender } = renderScan(["claude-code"]);
    expect(scanClient.opened).toEqual([["claude"]]);

    // Same roster, new array identity: no restart.
    rerender({ enabledProviderIds: ["claude-code"] });
    expect(scanClient.opened).toHaveLength(1);
    expect(scanClient.close).not.toHaveBeenCalled();

    // Codex toggled on: the old client closes and a new one opens with both,
    // in sorted order whatever order enablement listed them in.
    rerender({ enabledProviderIds: ["codex", "claude-code"] });
    expect(scanClient.close).toHaveBeenCalledTimes(1);
    expect(scanClient.opened).toEqual([["claude"], ["claude", "codex"]]);
    expect(result.current.providers).toEqual(["claude", "codex"]);
    // A roster change is a fresh scan, not a reconnect.
    expect(result.current.scan.state.phase).toBe("scanning");
  });

  it("opens no client when the host cannot scan", () => {
    stream.support = "unsupported";
    const { result } = renderScan(["claude-code"]);
    expect(result.current.eligible).toBe(false);
    expect(result.current.support).toBe("unsupported");
    expect(scanClient.opened).toHaveLength(0);
  });

  it("subscribes while support is still unknown on a live client, as the Settings dialog does", () => {
    stream.support = "unknown";
    const { result } = renderScan(["claude-code"]);
    expect(result.current.eligible).toBe(true);
    expect(scanClient.opened).toEqual([["claude"]]);
  });

  it("reads a null client as unknown support and opens nothing until one exists", () => {
    stream.client = null;
    stream.support = null;
    const { result } = renderScan(["claude-code"]);
    expect(result.current.support).toBe("unknown");
    expect(scanClient.opened).toHaveLength(0);
  });

  it("treats a transport drop as a reconnect: a deselected row stays deselected when the client returns", () => {
    const { result, rerender } = renderScan(["claude-code"]);
    const first = scanClient.callbacks;
    if (first === null) throw new Error("no scan client");
    act(() => {
      first.onStarted(["claude"]);
      first.onGroup(folderGroup([session("s1"), session("s2")]));
    });
    expect(result.current.scan.state.selected).toEqual(
      new Set(["claude:s1", "claude:s2"]),
    );
    act(() => {
      result.current.scan.dispatch({
        kind: "sessionToggled",
        selectionKey: "claude:s1",
      });
    });
    expect(result.current.scan.state.selected).toEqual(new Set(["claude:s2"]));

    // The stream closes: no client, support unknown. Nothing is torn down
    // beyond the client the hook's own cleanup closes, and the picks stay.
    stream.client = null;
    stream.support = null;
    rerender({ enabledProviderIds: ["claude-code"] });
    expect(scanClient.close).toHaveBeenCalledTimes(1);
    expect(result.current.scan.state.groups).toHaveLength(1);
    expect(result.current.scan.state.selected).toEqual(new Set(["claude:s2"]));

    // It comes back on the same host: a reconnect, and the re-delivered
    // group refreshes without re-ticking the row the user cleared.
    stream.client = { stream: "replacement" };
    stream.support = "supported";
    rerender({ enabledProviderIds: ["claude-code"] });
    expect(scanClient.opened).toEqual([["claude"], ["claude"]]);
    expect(result.current.scan.state.groups).toHaveLength(1);
    const second = scanClient.callbacks;
    if (second === null) throw new Error("no replacement scan client");
    act(() => {
      second.onStarted(["claude"]);
      second.onGroup(folderGroup([session("s1"), session("s2")]));
    });
    expect(result.current.scan.state.selected).toEqual(new Set(["claude:s2"]));
  });

  it("never opens a client over an empty roster", () => {
    const { result, rerender } = renderScan(["cursor", "traycer"]);
    expect(result.current.providers).toEqual([]);
    expect(result.current.eligible).toBe(false);
    expect(scanClient.opened).toHaveLength(0);

    rerender({ enabledProviderIds: [] });
    expect(scanClient.opened).toHaveLength(0);
  });

  it("counts importable rows across every group the scan produced", () => {
    const { result } = renderScan(["claude-code", "codex"]);
    expect(result.current.importableCount).toBe(0);
    const callbacks = scanClient.callbacks;
    if (callbacks === null) throw new Error("no scan client");
    act(() => {
      callbacks.onStarted(["claude", "codex"]);
      callbacks.onGroup({
        location: { kind: "folder", path: "/repo/a", workspaceId: null },
        gitBacked: true,
        sessions: [
          {
            harness: "claude",
            nativeSessionId: "s1",
            title: "One",
            firstPrompt: null,
            createdAt: 1,
            updatedAt: 1,
            messageCount: null,
            hasSubagents: false,
            state: { kind: "importable" },
          },
          {
            harness: "codex",
            nativeSessionId: "s2",
            title: "Two",
            firstPrompt: null,
            createdAt: 1,
            updatedAt: 1,
            messageCount: null,
            hasSubagents: false,
            state: { kind: "already_in_traycer", epicId: "e", chatId: "c" },
          },
        ],
      });
      callbacks.onGroup({
        location: { kind: "missing_folder", path: "/gone" },
        gitBacked: false,
        sessions: [
          {
            harness: "claude",
            nativeSessionId: "s3",
            title: "Three",
            firstPrompt: null,
            createdAt: 1,
            updatedAt: 1,
            messageCount: null,
            hasSubagents: false,
            state: { kind: "importable" },
          },
        ],
      });
    });
    expect(result.current.importableCount).toBe(2);
  });
});
