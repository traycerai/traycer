/**
 * The client half of the editor.openPaths "system" emission gate: a 1.0
 * host's request schema hard-rejects the literal, so this hook may only
 * return "system" once the handshake positively negotiated >= 1.1 - every
 * other state falls back to the default-editor behavior that predates it.
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

// The editor branch resolves through the offerable-target catalog, which asks
// the Finder gate too. Held closed here: this suite is about the "system"
// routing decision, and an offerable Finder would change what the fallback
// resolves to without being what any case is checking.
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));

import { usePdfOpenExternallyTarget } from "../use-pdf-open-target";

function resetSettingsStore(): void {
  useSettingsStore.setState({ defaultEditor: "vscode" });
}

describe("usePdfOpenExternallyTarget", () => {
  beforeEach(resetSettingsStore);
  afterEach(resetSettingsStore);

  it("targets the system application on a >= 1.1 host", () => {
    state.version = { major: 1, minor: 1 };
    useSettingsStore.setState({ defaultEditor: "cursor" });
    const { result } = renderHook(() => usePdfOpenExternallyTarget("host-A"));
    expect(result.current).toBe("system");
  });

  it("falls back to the default editor on a known 1.0 host", () => {
    state.version = { major: 1, minor: 0 };
    useSettingsStore.setState({ defaultEditor: "cursor" });
    const { result } = renderHook(() => usePdfOpenExternallyTarget("host-A"));
    expect(result.current).toBe("cursor");
  });

  it("falls back before any handshake has completed (fails closed)", () => {
    state.version = null;
    useSettingsStore.setState({ defaultEditor: "cursor" });
    const { result } = renderHook(() => usePdfOpenExternallyTarget("host-A"));
    expect(result.current).toBe("cursor");
  });

  it("falls back to vscode when no default editor is set", () => {
    state.version = null;
    useSettingsStore.setState({ defaultEditor: null });
    const { result } = renderHook(() => usePdfOpenExternallyTarget("host-A"));
    expect(result.current).toBe("vscode");
  });
});
