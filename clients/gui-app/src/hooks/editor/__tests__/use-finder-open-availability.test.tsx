/**
 * `useFinderOpenAvailability` gates a Finder affordance behind four
 * independent conditions (host is local, client is a Mac, not the installed
 * mobile app, negotiated `editor.openPaths` >= 1.1), and
 * `useEditorOpenPathsSupportsV11` is the version half of that gate on its
 * own. This suite drives the REAL hooks and mocks only their inputs: the host
 * handshake (`useHostMethodSchemaVersion`), the host directory entry
 * (`useHostDirectoryEntry`), and the platform/product signals (`isMac`,
 * `isMobileApp`). Mocking any of the hook's own boolean arithmetic instead of
 * these boundaries would stop the test from noticing a dropped or loosened
 * condition.
 *
 * Every case below starts from an all-true baseline and flips exactly ONE
 * condition, so a condition silently dropped from the hook (or loosened, e.g.
 * accepting minor 0) shows up as a specific failing test rather than a
 * generic "gate is broken" failure.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";

const state = vi.hoisted(
  (): {
    version: SchemaVersion | null;
    hostEntry: HostDirectoryEntry | null;
    isMac: boolean;
    isMobileApp: boolean;
  } => ({
    version: { major: 1, minor: 1 },
    hostEntry: {
      hostId: "host-A",
      label: "Host A",
      kind: "local",
      websocketUrl: "ws://127.0.0.1:1234",
      version: "1.2.0",
      transportDialability: "dialable",
    },
    isMac: true,
    isMobileApp: false,
  }),
);

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSchemaVersion: () => state.version,
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => state.hostEntry,
}));

vi.mock("@/lib/keybindings/platform", () => ({
  isMac: () => state.isMac,
}));

vi.mock("@/lib/mobile-app", () => ({
  isMobileApp: () => state.isMobileApp,
}));

import { useEditorOpenPathsSupportsV11 } from "../use-editor-open-paths-version";
import { useFinderOpenAvailability } from "../use-finder-open-availability";

function localHostEntry(kind: HostDirectoryEntry["kind"]): HostDirectoryEntry {
  return {
    hostId: "host-A",
    label: "Host A",
    kind,
    websocketUrl: "ws://127.0.0.1:1234",
    version: "1.2.0",
    transportDialability: "dialable",
  };
}

function resetToAllTrueBaseline(): void {
  state.version = { major: 1, minor: 1 };
  state.hostEntry = localHostEntry("local");
  state.isMac = true;
  state.isMobileApp = false;
}

beforeEach(resetToAllTrueBaseline);

describe("useFinderOpenAvailability", () => {
  it("is available when every condition holds", () => {
    const { result } = renderHook(() => useFinderOpenAvailability("host-A"));
    expect(result.current).toBe(true);
  });

  describe("version condition", () => {
    it("is unavailable at 1.0 (below the floor)", () => {
      state.version = { major: 1, minor: 0 };
      const { result } = renderHook(() => useFinderOpenAvailability("host-A"));
      expect(result.current).toBe(false);
    });

    it("is unavailable before any handshake has completed (fails closed)", () => {
      state.version = null;
      const { result } = renderHook(() => useFinderOpenAvailability("host-A"));
      expect(result.current).toBe(false);
    });

    it("is unavailable on a future major (major must stay 1)", () => {
      state.version = { major: 2, minor: 0 };
      const { result } = renderHook(() => useFinderOpenAvailability("host-A"));
      expect(result.current).toBe(false);
    });

    it("stays available past 1.1 (>= 1, not == 1)", () => {
      state.version = { major: 1, minor: 2 };
      const { result } = renderHook(() => useFinderOpenAvailability("host-A"));
      expect(result.current).toBe(true);
    });
  });

  describe("host-locality condition", () => {
    it("is unavailable on a remote host", () => {
      state.hostEntry = localHostEntry("remote");
      const { result } = renderHook(() => useFinderOpenAvailability("host-A"));
      expect(result.current).toBe(false);
    });

    it("is unavailable when the host entry is unresolved", () => {
      state.hostEntry = null;
      const { result } = renderHook(() => useFinderOpenAvailability("host-A"));
      expect(result.current).toBe(false);
    });

    it("is available on a mock host (mock counts as local)", () => {
      state.hostEntry = localHostEntry("mock");
      const { result } = renderHook(() => useFinderOpenAvailability("host-A"));
      expect(result.current).toBe(true);
    });
  });

  it("is unavailable on a non-Mac client", () => {
    state.isMac = false;
    const { result } = renderHook(() => useFinderOpenAvailability("host-A"));
    expect(result.current).toBe(false);
  });

  it("is unavailable inside the installed mobile app even though isMac() alone would read true on an iPad", () => {
    // An iPad's user agent contains "Macintosh", so isMac() can report true
    // there - this check has to be independently load-bearing rather than
    // implied by the Mac check above.
    state.isMobileApp = true;
    const { result } = renderHook(() => useFinderOpenAvailability("host-A"));
    expect(result.current).toBe(false);
  });
});

describe("useEditorOpenPathsSupportsV11", () => {
  it("is true at exactly 1.1", () => {
    // the shared beforeEach above resets state.version to { major: 1, minor: 1 }
    const { result } = renderHook(() =>
      useEditorOpenPathsSupportsV11("host-A"),
    );
    expect(result.current).toBe(true);
  });

  it("is true at 1.2", () => {
    state.version = { major: 1, minor: 2 };
    const { result } = renderHook(() =>
      useEditorOpenPathsSupportsV11("host-A"),
    );
    expect(result.current).toBe(true);
  });

  it("is false at 1.0", () => {
    state.version = { major: 1, minor: 0 };
    const { result } = renderHook(() =>
      useEditorOpenPathsSupportsV11("host-A"),
    );
    expect(result.current).toBe(false);
  });

  it("is false before any handshake has completed", () => {
    state.version = null;
    const { result } = renderHook(() =>
      useEditorOpenPathsSupportsV11("host-A"),
    );
    expect(result.current).toBe(false);
  });

  it("is false on a future major", () => {
    state.version = { major: 2, minor: 0 };
    const { result } = renderHook(() =>
      useEditorOpenPathsSupportsV11("host-A"),
    );
    expect(result.current).toBe(false);
  });
});
