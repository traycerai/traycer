/**
 * `useEffectiveDefaultEditor` resolves the stored, app-wide default editor
 * against ONE host's offerable set, falling back to the first offerable
 * editor when the stored id cannot be told to that host. This suite drives
 * the REAL hook (and the real `useOfferableEditors` / settings store it
 * composes) and mocks only the host handshake
 * (`useHostMethodSchemaVersion`) - the hook's actual input. The stored
 * default is set through the real Zustand store rather than mocked, so the
 * store's own read/write wiring stays exercised too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import { useSettingsStore } from "@/stores/settings/settings-store";

const state = vi.hoisted((): { version: SchemaVersion | null } => ({
  version: { major: 1, minor: 1 },
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSchemaVersion: () => state.version,
}));

import { useEffectiveDefaultEditor } from "../use-effective-default-editor";

function resetSettingsStore(): void {
  useSettingsStore.setState({ defaultEditor: "vscode" });
}

describe("useEffectiveDefaultEditor", () => {
  beforeEach(resetSettingsStore);
  afterEach(resetSettingsStore);

  it("returns the stored vscodium default on a 1.1 host", () => {
    state.version = { major: 1, minor: 1 };
    useSettingsStore.setState({ defaultEditor: "vscodium" });
    const { result } = renderHook(() => useEffectiveDefaultEditor("host-A"));
    expect(result.current).toBe("vscodium");
  });

  it("falls back off a stored vscodium default on a 1.0 host", () => {
    // A 1.0 host's editor.openPaths request schema hard-rejects the
    // "vscodium" literal at parse - emitting the stored default verbatim
    // here is exactly the regression this hook exists to prevent.
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

  it("falls back to vscode when no default editor is stored", () => {
    state.version = { major: 1, minor: 1 };
    useSettingsStore.setState({ defaultEditor: null });
    const { result } = renderHook(() => useEffectiveDefaultEditor("host-A"));
    expect(result.current).toBe("vscode");
  });
});
