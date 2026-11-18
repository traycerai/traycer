/**
 * The no-menu open surfaces' answer when this machine has no editor to send:
 * one toast, naming the editors THIS host can be told about, that does not pile
 * up under repeated clicks, and that re-probes so a user who installed one can
 * click again and succeed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { SchemaVersion } from "@traycer/protocol/framework/index";

const state = vi.hoisted((): { version: SchemaVersion | null } => ({
  version: { major: 1, minor: 3 },
}));
const toastInfo = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSchemaVersion: () => state.version,
}));

vi.mock("sonner", () => ({ toast: { info: toastInfo } }));

import { editorQueryKeys } from "@/lib/query-keys";
import { useNoEditorInstalledNotice } from "../use-no-editor-installed-notice";

function setup(): { notice: () => void; queryClient: QueryClient } {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useNoEditorInstalledNotice("host-A"), {
    wrapper,
  });
  return { notice: result.current, queryClient };
}

describe("useNoEditorInstalledNotice", () => {
  beforeEach(() => {
    state.version = { major: 1, minor: 3 };
    toastInfo.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows one info toast under a stable id, so repeated clicks do not stack", () => {
    const { notice } = setup();
    notice();
    notice();
    expect(toastInfo).toHaveBeenCalledTimes(2);
    for (const call of toastInfo.mock.calls) {
      expect(call[0]).toBe(
        "None of VS Code, Cursor, Windsurf, Zed, VSCodium or Code - OSS is installed on this computer; install one to open files from Traycer.",
      );
      expect(call[1]).toEqual({ id: "no-editor-installed" });
    }
  });

  it("names only the editors the host's negotiated minor can carry", () => {
    state.version = { major: 1, minor: 0 };
    const { notice } = setup();
    notice();
    expect(toastInfo).toHaveBeenCalledWith(
      "None of VS Code, Cursor, Windsurf or Zed is installed on this computer; install one to open files from Traycer.",
      { id: "no-editor-installed" },
    );
  });

  it("invalidates the install probe so the next click sees a fresh answer", () => {
    const { notice, queryClient } = setup();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    notice();
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: editorQueryKeys.availabilityAll(),
    });
  });
});
