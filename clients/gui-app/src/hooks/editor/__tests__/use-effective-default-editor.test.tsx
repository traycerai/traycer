/**
 * `useEffectiveDefaultEditor` resolves the stored, app-wide default against ONE
 * host's offerable targets, falling back to the first offerable one when the
 * stored id cannot be told to that host. Finder obeys the same rule as an
 * editor: it is a legal default only where its own gate holds.
 *
 * This suite drives the REAL hook (and the real `useOfferableEditors` /
 * `useFinderOpenAvailability` / settings store it composes), mocking only the
 * hook's inputs - the host handshake, the host directory entry, and the
 * platform/product signals. The stored default is set through the real Zustand
 * store rather than mocked, so its read/write wiring stays exercised too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { useSettingsStore } from "@/stores/settings/settings-store";

const state = vi.hoisted(
  (): {
    version: SchemaVersion | null;
    hostEntry: HostDirectoryEntry | null;
    isMac: boolean;
    isMobileApp: boolean;
  } => ({
    version: { major: 1, minor: 1 },
    hostEntry: null,
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

import { useEffectiveDefaultEditor } from "../use-effective-default-editor";

function hostEntry(kind: HostDirectoryEntry["kind"]): HostDirectoryEntry {
  return {
    hostId: "host-A",
    label: "Host A",
    kind,
    websocketUrl: "ws://127.0.0.1:1234",
    version: "1.1.0",
    transportDialability: "dialable",
  };
}

function resetSettingsStore(): void {
  useSettingsStore.setState({ defaultEditor: "vscode" });
}

/** Every condition the Finder gate needs, so one flip isolates one cause. */
function armFinderGate(): void {
  state.version = { major: 1, minor: 1 };
  state.hostEntry = hostEntry("local");
  state.isMac = true;
  state.isMobileApp = false;
}

describe("useEffectiveDefaultEditor", () => {
  beforeEach(() => {
    armFinderGate();
    resetSettingsStore();
  });
  afterEach(resetSettingsStore);

  it("returns the stored vscodium default on a 1.1 host", () => {
    useSettingsStore.setState({ defaultEditor: "vscodium" });
    const { result } = renderHook(() => useEffectiveDefaultEditor("host-A"));
    expect(result.current).toBe("vscodium");
  });

  it("falls back off a stored vscodium default on a 1.0 host", () => {
    // A 1.0 host's editor.openPaths request schema hard-rejects the
    // "vscodium" literal at parse.
    state.version = { major: 1, minor: 0 };
    useSettingsStore.setState({ defaultEditor: "vscodium" });
    const { result } = renderHook(() => useEffectiveDefaultEditor("host-A"));
    expect(result.current).toBe("vscode");
  });

  it("falls back off a stored vscodium default before any handshake has completed", () => {
    state.version = null;
    useSettingsStore.setState({ defaultEditor: "vscodium" });
    const { result } = renderHook(() => useEffectiveDefaultEditor("host-A"));
    expect(result.current).toBe("vscode");
  });

  it("leaves a 1.0-era default untouched on a 1.0 host", () => {
    // Discriminating control: the fallback is triggered by the id being
    // unofferable to this host, not unconditionally by the host's version.
    state.version = { major: 1, minor: 0 };
    useSettingsStore.setState({ defaultEditor: "cursor" });
    const { result } = renderHook(() => useEffectiveDefaultEditor("host-A"));
    expect(result.current).toBe("cursor");
  });

  it("falls back to vscode when no default is stored", () => {
    useSettingsStore.setState({ defaultEditor: null });
    const { result } = renderHook(() => useEffectiveDefaultEditor("host-A"));
    expect(result.current).toBe("vscode");
  });

  describe("a stored Finder default", () => {
    it("is effective while the Finder gate holds", () => {
      useSettingsStore.setState({ defaultEditor: "finder" });
      const { result } = renderHook(() => useEffectiveDefaultEditor("host-A"));
      expect(result.current).toBe("finder");
    });

    // One flip per case, so a dropped condition names itself. Each is a host
    // the stored preference is simply not legal on.
    it("falls back on a remote host", () => {
      state.hostEntry = hostEntry("remote");
      useSettingsStore.setState({ defaultEditor: "finder" });
      const { result } = renderHook(() => useEffectiveDefaultEditor("host-A"));
      expect(result.current).toBe("vscode");
    });

    it("falls back on a non-Mac client", () => {
      state.isMac = false;
      useSettingsStore.setState({ defaultEditor: "finder" });
      const { result } = renderHook(() => useEffectiveDefaultEditor("host-A"));
      expect(result.current).toBe("vscode");
    });

    it("falls back inside the installed mobile app", () => {
      state.isMobileApp = true;
      useSettingsStore.setState({ defaultEditor: "finder" });
      const { result } = renderHook(() => useEffectiveDefaultEditor("host-A"));
      expect(result.current).toBe("vscode");
    });

    it("falls back on a 1.0 host", () => {
      state.version = { major: 1, minor: 0 };
      useSettingsStore.setState({ defaultEditor: "finder" });
      const { result } = renderHook(() => useEffectiveDefaultEditor("host-A"));
      expect(result.current).toBe("vscode");
    });
  });
});
