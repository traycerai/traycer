import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX, ReactNode } from "react";

/**
 * Outcome delivery for the three pack-version mutations.
 *
 * WHY THIS FILE EXISTS. The panel that used to own these messages mocks all
 * three hooks (`provider-pack-version-manager-panel.test.tsx` calls `vi.mock`
 * on each), so every assertion it makes runs against a stub. Moving the
 * outcome handling INTO the hooks therefore moved it into the one place that
 * suite structurally cannot see - and there was no hook-level suite at all.
 * A green panel run says nothing about any of the behaviour below.
 */

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    info: mocks.toastInfo,
  },
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => ({
    request: mocks.request,
    getActiveHostId: () => HOST_ID,
  }),
}));

import {
  createVersionManagerPanelToken,
  registerVersionManagerPanel,
  resetVersionManagerPanelPresence,
  versionManagerPanelIsMounted,
} from "@/components/settings/panels/provider-pack-version-manager-presence";
import { useProvidersUsePackVersion } from "@/hooks/providers/use-providers-use-pack-version-mutation";
import { useProvidersRemovePackVersion } from "@/hooks/providers/use-providers-remove-pack-version-mutation";
import { useProvidersInstallPackVersion } from "@/hooks/providers/use-providers-install-pack-version-mutation";

const HOST_ID = "host-1";

function wrapper(): (props: { children: ReactNode }) => JSX.Element {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper(props: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );
  };
}

beforeEach(() => {
  resetVersionManagerPanelPresence();
  mocks.request.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
  mocks.toastInfo.mockReset();
});

afterEach(() => {
  cleanup();
  resetVersionManagerPanelPresence();
});

describe("usePackVersion outcome delivery", () => {
  it("confirms a switch even though the panel that requested it is gone", async () => {
    mocks.request.mockResolvedValue({
      result: { ok: true, pinnedVersion: "2.0.0" },
    });
    const { result } = renderHook(() => useProvidersUsePackVersion(null), {
      wrapper: wrapper(),
    });

    result.current.mutate({ packId: "opencode", version: "2.0.0" });

    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "New sessions will use 2.0.0",
      );
    });
  });

  it("distinguishes a cleared pin from a switch on the same RPC", async () => {
    mocks.request.mockResolvedValue({
      result: { ok: true, pinnedVersion: null },
    });
    const { result } = renderHook(() => useProvidersUsePackVersion(null), {
      wrapper: wrapper(),
    });

    result.current.mutate({ packId: "opencode", version: null });

    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Pin cleared — new sessions follow automatic version selection",
      );
    });
  });

  it("toasts a TYPED refusal when no panel is mounted to draw it inline", async () => {
    // The defect this covers: `ok: false` is a SUCCESSFUL response, so it never
    // reaches `onError`. Before this, it was handled only per call and died
    // with the popover.
    mocks.request.mockResolvedValue({
      result: { ok: false, code: "below-security-floor", detail: null },
    });
    const { result } = renderHook(() => useProvidersUsePackVersion(null), {
      wrapper: wrapper(),
    });

    result.current.mutate({ packId: "opencode", version: "0.1.0" });

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Below the publisher's security minimum — cannot select",
      );
    });
  });

  it("stays silent on a refusal while the panel is mounted to render it", async () => {
    const panel = createVersionManagerPanelToken("opencode");
    const release = registerVersionManagerPanel(panel);
    mocks.request.mockResolvedValue({
      result: { ok: false, code: "below-security-floor", detail: null },
    });
    const { result } = renderHook(() => useProvidersUsePackVersion(panel), {
      wrapper: wrapper(),
    });

    result.current.mutate({ packId: "opencode", version: "0.1.0" });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    // The panel owns the inline notice; a toast here would double-report it.
    expect(mocks.toastError).not.toHaveBeenCalled();
    release();
  });

  it("toasts when the INITIATING panel is gone even though another remains", async () => {
    // The defect a global count reintroduces. Pack A's request is in flight;
    // the user opens pack B's popover, so A unmounts while the count stays
    // above zero. A's refusal has no inline surface left - B has no row for it
    // and never asked - so suppressing the toast loses the outcome entirely.
    const packA = createVersionManagerPanelToken("opencode");
    const releaseA = registerVersionManagerPanel(packA);
    const packB = createVersionManagerPanelToken("claude");
    const releaseB = registerVersionManagerPanel(packB);

    mocks.request.mockResolvedValue({
      result: { ok: false, code: "below-security-floor", detail: null },
    });
    const { result } = renderHook(() => useProvidersUsePackVersion(packA), {
      wrapper: wrapper(),
    });

    result.current.mutate({ packId: "opencode", version: "0.1.0" });
    // A's popover closes mid-flight; B stays open.
    releaseA();

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Below the publisher's security minimum — cannot select",
      );
    });
    releaseB();
  });

  it("reports the pin the host durably kept, not the one we asked for", async () => {
    // `ok: true` echoes `pinnedVersion` because another host sharing the pack
    // store can win the write. Announcing `variables.version` would claim a pin
    // that is not in force.
    mocks.request.mockResolvedValue({
      result: { ok: true, pinnedVersion: "3.0.0" },
    });
    const { result } = renderHook(() => useProvidersUsePackVersion(null), {
      wrapper: wrapper(),
    });

    result.current.mutate({ packId: "opencode", version: "2.0.0" });

    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "New sessions will use 3.0.0",
      );
    });
  });

  it("reports a clear that another host has already replaced with a pin", async () => {
    mocks.request.mockResolvedValue({
      result: { ok: true, pinnedVersion: "3.0.0" },
    });
    const { result } = renderHook(() => useProvidersUsePackVersion(null), {
      wrapper: wrapper(),
    });

    result.current.mutate({ packId: "opencode", version: null });

    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "New sessions will use 3.0.0",
      );
    });
  });
});

describe("remove outcome delivery", () => {
  it("reports deferred-locked as info, not as a failure", async () => {
    // The row deliberately draws this one as info: the delete IS recorded and
    // runs at turnover. Toasting it red would contradict the row.
    mocks.request.mockResolvedValue({
      result: { ok: false, code: "deferred-locked", detail: null },
    });
    const { result } = renderHook(() => useProvidersRemovePackVersion(null), {
      wrapper: wrapper(),
    });

    result.current.mutate({ packId: "opencode", version: "1.0.0" });

    await waitFor(() => {
      expect(mocks.toastInfo).toHaveBeenCalled();
    });
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("toasts a genuine removal refusal as an error", async () => {
    mocks.request.mockResolvedValue({
      result: { ok: false, code: "quarantine-reserved", detail: null },
    });
    const { result } = renderHook(() => useProvidersRemovePackVersion(null), {
      wrapper: wrapper(),
    });

    result.current.mutate({ packId: "opencode", version: "1.0.0" });

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalled();
    });
    expect(mocks.toastInfo).not.toHaveBeenCalled();
  });
});

describe("install outcome delivery", () => {
  it("toasts an install refusal once the panel is gone", async () => {
    mocks.request.mockResolvedValue({
      result: { ok: false, code: "condemned", detail: null },
    });
    const { result } = renderHook(() => useProvidersInstallPackVersion(null), {
      wrapper: wrapper(),
    });

    result.current.mutate({ packId: "opencode", version: "1.0.0" });

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Install failed permanently on this machine",
      );
    });
  });
});

describe("panel presence accounting", () => {
  it("answers about the panel asked about, not about panels in general", () => {
    // Settings can mount a panel for a second pack before the first finishes
    // unmounting. Each answer has to be about the token handed in: the first
    // panel is gone, the second is not, and one question cannot return the
    // other's answer.
    const first = createVersionManagerPanelToken("opencode");
    const releaseFirst = registerVersionManagerPanel(first);
    const second = createVersionManagerPanelToken("claude");
    const releaseSecond = registerVersionManagerPanel(second);

    releaseFirst();
    expect(versionManagerPanelIsMounted(first)).toBe(false);
    expect(versionManagerPanelIsMounted(second)).toBe(true);

    releaseSecond();
    expect(versionManagerPanelIsMounted(second)).toBe(false);
  });

  it("gives two panels for the same pack distinct identities", () => {
    // The pack id is a debugging label, not the key. Two popovers for one pack
    // are two surfaces, and releasing one must not answer for the other.
    const first = createVersionManagerPanelToken("opencode");
    const second = createVersionManagerPanelToken("opencode");
    const releaseFirst = registerVersionManagerPanel(first);
    registerVersionManagerPanel(second);

    releaseFirst();
    expect(versionManagerPanelIsMounted(first)).toBe(false);
    expect(versionManagerPanelIsMounted(second)).toBe(true);
  });

  it("treats an unclaimed outcome as one the hook must report", () => {
    // No token means no panel ever claimed the outcome, so there is nothing on
    // screen to draw it and the hook has to toast.
    expect(versionManagerPanelIsMounted(null)).toBe(false);
  });

  it("releases only once, so a re-invoked effect cleanup cannot unregister a live panel", () => {
    // React double-invokes effects in development: mount, cleanup, mount. The
    // second cleanup call must not delete the registration the re-run just
    // made, which would report "no panel" with a panel mounted and silently
    // restore the original defect.
    const panel = createVersionManagerPanelToken("opencode");
    const release = registerVersionManagerPanel(panel);
    release();
    registerVersionManagerPanel(panel);
    release();

    expect(versionManagerPanelIsMounted(panel)).toBe(true);
  });
});
