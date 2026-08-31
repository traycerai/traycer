/**
 * The client half of the editor.openPaths "system" emission gate: a 1.0
 * host's request schema hard-rejects the literal, so this hook may only
 * return "system" once the handshake positively negotiated >= 1.1 - every
 * other state falls back to the default-editor behavior that predates it.
 */
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { SchemaVersion } from "@traycer/protocol/framework/index";

const state = vi.hoisted(
  (): {
    version: SchemaVersion | null;
    defaultEditor: string | null;
  } => ({
    version: { major: 1, minor: 1 },
    defaultEditor: "cursor",
  }),
);

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSchemaVersion: () => state.version,
}));

vi.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (
    selector: (value: { defaultEditor: string | null }) => unknown,
  ) => selector({ defaultEditor: state.defaultEditor }),
}));

import { usePdfOpenExternallyTarget } from "../use-pdf-open-target";

describe("usePdfOpenExternallyTarget", () => {
  it("targets the system application on a >= 1.1 host", () => {
    state.version = { major: 1, minor: 1 };
    const { result } = renderHook(() => usePdfOpenExternallyTarget("host-A"));
    expect(result.current).toBe("system");
  });

  it("falls back to the default editor on a known 1.0 host", () => {
    state.version = { major: 1, minor: 0 };
    const { result } = renderHook(() => usePdfOpenExternallyTarget("host-A"));
    expect(result.current).toBe("cursor");
  });

  it("falls back before any handshake has completed (fails closed)", () => {
    state.version = null;
    const { result } = renderHook(() => usePdfOpenExternallyTarget("host-A"));
    expect(result.current).toBe("cursor");
  });

  it("falls back to vscode when no default editor is set", () => {
    state.version = null;
    state.defaultEditor = null;
    const { result } = renderHook(() => usePdfOpenExternallyTarget("host-A"));
    expect(result.current).toBe("vscode");
  });
});
