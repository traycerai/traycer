/**
 * The client half of the editor.openPaths "system" emission gate, now per
 * document format: a 1.0 host's request schema hard-rejects the literal and a
 * 1.1 host rejects a `.docx` path behind it, so this hook may only return
 * "system" once the handshake positively negotiated the minor that admitted
 * THAT format - pdf from 1.1, Word documents from 1.2. Every other state falls
 * back to the default-editor behavior that predates it.
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

import { useDocumentOpenExternallyTarget } from "../use-document-open-target";

function resetSettingsStore(): void {
  useSettingsStore.setState({ defaultEditor: "vscode" });
}

describe("useDocumentOpenExternallyTarget", () => {
  beforeEach(resetSettingsStore);
  afterEach(resetSettingsStore);

  it("targets the system application for a PDF on a >= 1.1 host", () => {
    state.version = { major: 1, minor: 1 };
    useSettingsStore.setState({ defaultEditor: "cursor" });
    const { result } = renderHook(() =>
      useDocumentOpenExternallyTarget("host-A", "pdf"),
    );
    expect(result.current).toBe("system");
  });

  // 1.2 is a schema-identical BEHAVIOR minor: the literal parses on a 1.1
  // host, but that host refuses a `.docx` path behind it - so the format's own
  // floor, not the target's, is what this hook gates on.
  it("falls back to the default editor for a Word document on a 1.1 host", () => {
    state.version = { major: 1, minor: 1 };
    useSettingsStore.setState({ defaultEditor: "cursor" });
    const { result } = renderHook(() =>
      useDocumentOpenExternallyTarget("host-A", "docx"),
    );
    expect(result.current).toBe("cursor");
  });

  it("targets the system application for a Word document on a >= 1.2 host", () => {
    state.version = { major: 1, minor: 2 };
    useSettingsStore.setState({ defaultEditor: "cursor" });
    const { result } = renderHook(() =>
      useDocumentOpenExternallyTarget("host-A", "docx"),
    );
    expect(result.current).toBe("system");
  });

  it("falls back to the default editor on a known 1.0 host", () => {
    state.version = { major: 1, minor: 0 };
    useSettingsStore.setState({ defaultEditor: "cursor" });
    const { result } = renderHook(() =>
      useDocumentOpenExternallyTarget("host-A", "pdf"),
    );
    expect(result.current).toBe("cursor");
  });

  it("falls back before any handshake has completed (fails closed)", () => {
    state.version = null;
    useSettingsStore.setState({ defaultEditor: "cursor" });
    const { result } = renderHook(() =>
      useDocumentOpenExternallyTarget("host-A", "pdf"),
    );
    expect(result.current).toBe("cursor");
  });

  it("falls back to vscode when no default editor is set", () => {
    state.version = null;
    useSettingsStore.setState({ defaultEditor: null });
    const { result } = renderHook(() =>
      useDocumentOpenExternallyTarget("host-A", "docx"),
    );
    expect(result.current).toBe("vscode");
  });
});
