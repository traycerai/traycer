/**
 * `useOfferableEditors` narrows the protocol's `EDITORS` registry to the ids
 * a host's negotiated `editor.openPaths` minor can actually accept on the
 * wire. This suite drives the REAL hook and mocks only its input, the host
 * handshake (`useHostMethodSchemaVersion`) - never the hook's own filtering
 * logic. It asserts against the real `EDITORS` registry rather than a
 * hand-copied id list, so the suite keeps tracking the registry (and any
 * future minor's addition) instead of silently going stale next to it.
 */
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import { EDITORS } from "@traycer/protocol/host";

const state = vi.hoisted((): { version: SchemaVersion | null } => ({
  version: { major: 1, minor: 1 },
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSchemaVersion: () => state.version,
}));

import { useOfferableEditors } from "../use-offerable-editors";

const ALL_EDITOR_IDS = EDITORS.map((editor) => editor.id);
const NEWER_THAN_V11_IDS = ["code-oss"];

describe("useOfferableEditors", () => {
  it("offers every registry editor on a 1.3 host", () => {
    state.version = { major: 1, minor: 3 };
    const { result } = renderHook(() => useOfferableEditors("host-A"));
    expect(result.current.map((editor) => editor.id)).toEqual(ALL_EDITOR_IDS);
    expect(result.current.some((editor) => editor.id === "code-oss")).toBe(
      true,
    );
  });

  it("offers vscodium but not code-oss on a 1.1 or 1.2 host", () => {
    for (const minor of [1, 2]) {
      state.version = { major: 1, minor };
      const { result } = renderHook(() => useOfferableEditors("host-A"));
      const offeredIds = result.current.map((editor) => editor.id);
      expect(offeredIds).toContain("vscodium");
      for (const id of NEWER_THAN_V11_IDS) {
        expect(offeredIds).not.toContain(id);
      }
    }
  });

  it("excludes vscodium on a 1.0 host while keeping every other registry editor", () => {
    state.version = { major: 1, minor: 0 };
    const { result } = renderHook(() => useOfferableEditors("host-A"));
    const offeredIds = result.current.map((editor) => editor.id);
    expect(offeredIds).not.toContain("vscodium");
    expect(offeredIds).not.toContain("code-oss");
    for (const id of ALL_EDITOR_IDS) {
      if (id === "vscodium" || id === "code-oss") continue;
      expect(offeredIds).toContain(id);
    }
    expect(offeredIds).toHaveLength(ALL_EDITOR_IDS.length - 2);
  });

  it("excludes vscodium before any handshake has completed (fails closed)", () => {
    state.version = null;
    const { result } = renderHook(() => useOfferableEditors("host-A"));
    expect(result.current.map((editor) => editor.id)).not.toContain("vscodium");
    expect(result.current.map((editor) => editor.id)).not.toContain("code-oss");
  });

  it("returns a referentially stable array across re-renders with an unchanged version", () => {
    state.version = { major: 1, minor: 3 };
    const { result, rerender } = renderHook(() =>
      useOfferableEditors("host-A"),
    );
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
