import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderManagedVersions,
  ProviderPackVersion,
} from "@traycer/protocol/host/provider-schemas";
import {
  PROVIDER_PACK_VERSION_MANAGER_CAPABILITY_METHOD,
  ProviderPackVersionManagerPanel,
} from "@/components/settings/panels/provider-pack-version-manager-panel";

type UsePackVersionVariables = {
  readonly packId: string;
  readonly version: string | null;
};

type UsePackVersionRefusalCode =
  | "pin-below-floor"
  | "verification-failed"
  | "below-security-floor"
  | "host-ineligible";

type UseMutateOptions = {
  readonly onSuccess?: (response: {
    readonly result:
      | { readonly ok: true; readonly pinnedVersion: string | null }
      | {
          readonly ok: false;
          readonly code: UsePackVersionRefusalCode;
          readonly detail: string | null;
        };
  }) => void;
  readonly onSettled?: () => void;
  readonly onError?: (error: unknown) => void;
};

type HostMethodSupportArgs = {
  readonly hostId: string | null;
  readonly method: string;
};

type InstallPackVersionVariables = {
  readonly packId: string;
  readonly version: string;
};

type InstallMutateOptions = {
  readonly onSuccess?: (response: {
    readonly result:
      | {
          readonly ok: true;
          readonly installState: { readonly status: string };
        }
      | {
          readonly ok: false;
          readonly code:
            | "condemned"
            | "unfetchable"
            | "invalid-version"
            | "pin-below-floor"
            | "below-security-floor"
            | "host-ineligible"
            | "yanked";
          readonly detail: string | null;
        };
  }) => void;
  readonly onSettled?: () => void;
  readonly onError?: (error: unknown) => void;
};

const mocks = vi.hoisted(() => {
  const supportByHostId = new Map<string, boolean | null>();
  let lastSupportArgs: HostMethodSupportArgs | null = null;
  let defaultSupport: boolean | null = true;
  return {
    installMutate:
      vi.fn<
        (
          variables: InstallPackVersionVariables,
          options: InstallMutateOptions,
        ) => void
      >(),
    removeMutate: vi.fn(),
    useMutate:
      vi.fn<
        (variables: UsePackVersionVariables, options: UseMutateOptions) => void
      >(),
    setPolicyMutate: vi.fn(),
    /**
     * Per-host capability map. The gate must consult the *passed* hostId, not an
     * ambient default — regressions would re-introduce scoped-host bugs.
     */
    get supportByHostId() {
      return supportByHostId;
    },
    get lastSupportArgs() {
      return lastSupportArgs;
    },
    set lastSupportArgs(value: HostMethodSupportArgs | null) {
      lastSupportArgs = value;
    },
    get defaultSupport() {
      return defaultSupport;
    },
    set defaultSupport(value: boolean | null) {
      defaultSupport = value;
    },
  };
});

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (hostId: string | null, method: string) => {
    mocks.lastSupportArgs = { hostId, method };
    if (hostId === null) return null;
    if (mocks.supportByHostId.has(hostId)) {
      return mocks.supportByHostId.get(hostId) ?? null;
    }
    return mocks.defaultSupport;
  },
  useHostSupportsMethod: (hostId: string | null) => {
    if (hostId === null) return false;
    if (mocks.supportByHostId.has(hostId)) {
      return mocks.supportByHostId.get(hostId) === true;
    }
    return mocks.defaultSupport === true;
  },
}));

vi.mock(
  "@/hooks/providers/use-providers-install-pack-version-mutation",
  () => ({
    useProvidersInstallPackVersion: () => ({
      mutate: mocks.installMutate,
      isPending: false,
    }),
  }),
);

vi.mock("@/hooks/providers/use-providers-remove-pack-version-mutation", () => ({
  useProvidersRemovePackVersion: () => ({
    mutate: mocks.removeMutate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-use-pack-version-mutation", () => ({
  useProvidersUsePackVersion: () => ({
    mutate: mocks.useMutate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-set-pack-policy-mutation", () => ({
  useProvidersSetPackPolicy: () => ({
    mutate: mocks.setPolicyMutate,
    isPending: false,
  }),
}));

function version(
  partial: Partial<ProviderPackVersion> & Pick<ProviderPackVersion, "version">,
): ProviderPackVersion {
  return {
    sizeBytes: 40_000_000,
    certification: "eligible",
    recommended: false,
    current: false,
    installState: { status: "installed" },
    ...partial,
  };
}

function managed(
  available: readonly ProviderPackVersion[],
  overrides: Partial<ProviderManagedVersions> | null,
): ProviderManagedVersions {
  const base: ProviderManagedVersions = {
    autoDownload: true,
    pinnedVersion: null,
    updateAvailable: null,
    sharedWithProviders: [],
    totalSizeBytes: 40_000_000,
    available: [...available],
  };
  if (overrides === null) return base;
  return { ...base, ...overrides };
}

function renderPanel(options: {
  readonly hostId: string | null;
  readonly available: readonly ProviderPackVersion[];
  readonly managedOverrides: Partial<ProviderManagedVersions> | null;
}): void {
  render(
    <ProviderPackVersionManagerPanel
      hostId={options.hostId}
      packId="opencode"
      packDisplayName="opencode CLI"
      managedVersions={managed(options.available, options.managedOverrides)}
    />,
  );
}

describe("<ProviderPackVersionManagerPanel /> install-state surfaces", () => {
  afterEach(() => {
    cleanup();
    mocks.installMutate.mockReset();
    mocks.removeMutate.mockReset();
    mocks.useMutate.mockReset();
    mocks.setPolicyMutate.mockReset();
    mocks.supportByHostId.clear();
    mocks.lastSupportArgs = null;
    mocks.defaultSupport = true;
  });

  it("shows pending when hostId is null (scoped host not ready), not unsupported", () => {
    // Even if some ambient default would say "supported", null hostId is
    // absence of knowledge.
    mocks.defaultSupport = true;
    renderPanel({
      hostId: null,
      available: [version({ version: "1.0.0" })],
      managedOverrides: null,
    });
    expect(
      screen.getByTestId("provider-pack-version-manager-pending"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("provider-pack-version-manager-unsupported"),
    ).toBeNull();
    expect(screen.queryByTestId("provider-pack-version-manager")).toBeNull();
    expect(mocks.lastSupportArgs).toEqual({
      hostId: null,
      method: PROVIDER_PACK_VERSION_MANAGER_CAPABILITY_METHOD,
    });
  });

  it("gates capability on the passed hostId, not an ambient host", () => {
    // Scoped host B lacks the methods; a different host A would be supported.
    // The panel must consult B only.
    mocks.supportByHostId.set("host-A", true);
    mocks.supportByHostId.set("host-B", false);
    mocks.defaultSupport = true;

    renderPanel({
      hostId: "host-B",
      available: [version({ version: "1.0.0" })],
      managedOverrides: null,
    });

    expect(mocks.lastSupportArgs).toEqual({
      hostId: "host-B",
      method: PROVIDER_PACK_VERSION_MANAGER_CAPABILITY_METHOD,
    });
    expect(
      screen.getByTestId("provider-pack-version-manager-unsupported"),
    ).toBeTruthy();
    expect(screen.queryByTestId("provider-pack-version-manager")).toBeNull();
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();

    cleanup();
    mocks.lastSupportArgs = null;

    renderPanel({
      hostId: "host-A",
      available: [version({ version: "1.0.0" })],
      managedOverrides: null,
    });
    expect(mocks.lastSupportArgs).toEqual({
      hostId: "host-A",
      method: PROVIDER_PACK_VERSION_MANAGER_CAPABILITY_METHOD,
    });
    const panel = screen.getByTestId("provider-pack-version-manager");
    expect(panel).toBeTruthy();
    expect(panel.getAttribute("data-host-id")).toBe("host-A");
  });

  it("shows a pending surface while handshake method support is unknown (null), not unsupported", () => {
    mocks.supportByHostId.set("host-1", null);
    renderPanel({
      hostId: "host-1",
      available: [version({ version: "1.0.0" })],
      managedOverrides: null,
    });
    expect(
      screen.getByTestId("provider-pack-version-manager-pending"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("provider-pack-version-manager-unsupported"),
    ).toBeNull();
    expect(screen.queryByTestId("provider-pack-version-manager")).toBeNull();
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
  });

  it("shows unsupported copy when the host completed handshake without the methods", () => {
    mocks.supportByHostId.set("host-1", false);
    renderPanel({
      hostId: "host-1",
      available: [version({ version: "1.0.0" })],
      managedOverrides: null,
    });
    expect(
      screen.getByTestId("provider-pack-version-manager-unsupported"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("provider-pack-version-manager-pending"),
    ).toBeNull();
    expect(screen.queryByTestId("provider-pack-version-manager")).toBeNull();
    // Capability gate: no offered-then-failed action buttons.
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Use" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("renders indeterminate progress for downloading with null percent, not error copy", () => {
    renderPanel({
      hostId: "host-1",
      available: [
        version({
          version: "1.4.0",
          installState: { status: "downloading", percent: null },
        }),
      ],
      managedOverrides: null,
    });

    expect(screen.getByTestId("download-progress-indeterminate")).toBeTruthy();
    expect(screen.queryByTestId("download-progress-determinate")).toBeNull();
    expect(screen.queryByTestId("condemned-no-retry")).toBeNull();
    expect(screen.queryByTestId("version-row-notice")).toBeNull();
    // Row meta should describe progress, not a permanent/destructive failure.
    // textContent is typed non-null on HTMLElement; assert the real string.
    const row = screen.getByTestId("provider-pack-version-row-1.4.0");
    expect(row.textContent).toMatch(/Downloading/i);
    expect(row.textContent).not.toMatch(
      /failed permanently|Install failed permanently/i,
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows condemned-no-retry and hides Retry for condemned unusable rows", () => {
    renderPanel({
      hostId: "host-1",
      available: [
        version({
          version: "1.0.0",
          installState: { status: "unusable", reason: "condemned" },
        }),
      ],
      managedOverrides: null,
    });

    expect(screen.getByTestId("condemned-no-retry")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
    const row = screen.getByTestId("provider-pack-version-row-1.0.0");
    expect(row.textContent).toMatch(/permanently/i);
  });

  it("renders Recommended and Current badges when those flags are set", () => {
    renderPanel({
      hostId: "host-1",
      available: [
        version({
          version: "1.2.0",
          recommended: true,
          current: true,
          installState: { status: "installed" },
        }),
      ],
      managedOverrides: null,
    });

    expect(screen.getByTestId("badge-recommended")).toBeTruthy();
    expect(screen.getByTestId("badge-current")).toBeTruthy();
  });

  it("offers no Download or Retry button for a non-retryable error (finding 1)", () => {
    renderPanel({
      hostId: "host-1",
      available: [
        version({
          version: "1.0.0",
          installState: {
            status: "error",
            reason: "trust-unavailable",
            message: "Trust store unavailable",
            retryAtMs: null,
          },
        }),
      ],
      managedOverrides: null,
    });

    const row = screen.getByTestId("provider-pack-version-row-1.0.0");
    expect(row).toBeTruthy();
    // Composition: allow-list denies retry AND download eligibility denies —
    // no actionable install-fetch button under either label.
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows Retry (not Download) for a retryable network error", () => {
    renderPanel({
      hostId: "host-1",
      available: [
        version({
          version: "1.0.0",
          installState: {
            status: "error",
            reason: "network",
            message: "timeout",
            retryAtMs: null,
          },
        }),
      ],
      managedOverrides: null,
    });

    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
  });

  it("clears the pin by sending version: null when Use latest automatically is clicked", async () => {
    const user = userEvent.setup();
    renderPanel({
      hostId: "host-1",
      available: [
        version({
          version: "1.2.0",
          current: true,
          installState: { status: "installed" },
        }),
        version({
          version: "1.3.0",
          installState: { status: "installed" },
        }),
      ],
      managedOverrides: { pinnedVersion: "1.2.0", autoDownload: false },
    });

    expect(screen.getByTestId("provider-pack-pinned-banner")).toBeTruthy();
    const clear = screen.getByTestId("provider-pack-clear-pin");
    await user.click(clear);

    expect(mocks.useMutate).toHaveBeenCalledTimes(1);
    // Typed mock: first arg is UsePackVersionVariables (not any).
    expect(mocks.useMutate.mock.calls[0]?.[0]).toEqual({
      packId: "opencode",
      version: null,
    });
  });

  it("composes uncertified + unverified without claiming still usable", () => {
    renderPanel({
      hostId: "host-1",
      available: [
        version({
          version: "1.1.0",
          certification: "uncertified",
          installState: { status: "unusable", reason: "unverified" },
        }),
      ],
      managedOverrides: null,
    });

    const meta = screen.getByTestId("version-row-meta");
    // getByTestId yields a mounted HTMLElement; textContent is the composed
    // meta string (always non-empty for this fixture). No ?? — that was the
    // lint-only safety that made the assertion look optional.
    const text = meta.textContent;
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
    expect(text.toLowerCase()).toMatch(/not necessarily damaged/);
    expect(text.toLowerCase()).not.toMatch(/still usable/);
  });

  it("disables Use offline when no recommended baseline row is present", () => {
    // Integration finding 1: current 3.0.0, retained 1.0.0, baked 2.0.0 absent.
    renderPanel({
      hostId: "host-1",
      available: [
        version({
          version: "3.0.0",
          current: true,
          recommended: false,
          installState: { status: "installed" },
        }),
        version({
          version: "1.0.0",
          recommended: false,
          installState: { status: "installed" },
        }),
      ],
      managedOverrides: null,
    });

    // Use remains visible but disabled with an honest reason (fail closed).
    const useButton = screen.getByRole("button", { name: "Use" });
    expect(useButton.hasAttribute("disabled")).toBe(true);
    const disabled = screen.getByTestId("use-disabled-reason");
    expect(disabled.textContent.toLowerCase()).toMatch(/baseline|reconnect/);
  });

  it("disables the update banner Download when the durable version has no row", () => {
    renderPanel({
      hostId: "host-1",
      available: [
        version({
          version: "1.0.0",
          current: true,
          installState: { status: "installed" },
        }),
      ],
      managedOverrides: {
        updateAvailable: { version: "9.9.9" },
      },
    });

    const download = screen.getByTestId("provider-pack-update-download");
    expect(download.hasAttribute("disabled")).toBe(true);
    const reason = screen.getByTestId(
      "provider-pack-update-banner-disabled-reason",
    );
    expect(reason.textContent.toLowerCase()).toMatch(
      /fetchable|reconnect|download/,
    );
  });

  it("renders yanked install refusal copy on the version row (not 'right now')", async () => {
    const user = userEvent.setup();
    mocks.installMutate.mockImplementation((_vars, options) => {
      options.onSuccess?.({
        result: {
          ok: false,
          code: "yanked",
          detail: null,
        },
      });
      options.onSettled?.();
    });

    renderPanel({
      hostId: "host-1",
      available: [
        version({
          version: "1.5.0",
          installState: { status: "absent" },
        }),
      ],
      managedOverrides: null,
    });

    await user.click(screen.getByRole("button", { name: "Download" }));
    const notice = screen.getByTestId("version-row-notice");
    expect(notice.textContent.toLowerCase()).toMatch(/withdrawn/);
    expect(notice.textContent.toLowerCase()).not.toMatch(/right now/);
  });

  it("orders release ahead of prereleases (SemVer, not localeCompare)", () => {
    renderPanel({
      hostId: "host-1",
      available: [
        version({ version: "1.0.0-rc.1", installState: { status: "absent" } }),
        version({
          version: "1.0.0-beta.11",
          installState: { status: "absent" },
        }),
        version({
          version: "1.0.0-beta.2",
          installState: { status: "absent" },
        }),
        version({ version: "1.0.0", installState: { status: "installed" } }),
      ],
      managedOverrides: null,
    });

    const rows = screen.getAllByTestId(/^provider-pack-version-row-/);
    const versions = rows.map((row) => row.getAttribute("data-version"));
    expect(versions).toEqual([
      "1.0.0",
      "1.0.0-rc.1",
      "1.0.0-beta.11",
      "1.0.0-beta.2",
    ]);
  });

  it.each([
    {
      code: "below-security-floor" as const,
      expectMatch: /security minimum/i,
      forbid: /withdrawn|right now/i,
    },
    {
      code: "host-ineligible" as const,
      expectMatch: /cannot run/i,
      forbid: /withdrawn|right now/i,
    },
    {
      code: "pin-below-floor" as const,
      expectMatch: /baseline|select/i,
      forbid: /withdrawn|right now/i,
    },
    {
      code: "verification-failed" as const,
      expectMatch: /verif/i,
      forbid: /withdrawn/i,
    },
  ])(
    "renders Use refusal copy for $code without withdrawn/retry invitation",
    async ({ code, expectMatch, forbid }) => {
      const user = userEvent.setup();
      mocks.useMutate.mockImplementation((_vars, options) => {
        options.onSuccess?.({
          result: { ok: false, code, detail: null },
        });
        options.onSettled?.();
      });

      renderPanel({
        hostId: "host-1",
        available: [
          version({
            version: "1.0.0",
            recommended: true,
            current: true,
            installState: { status: "installed" },
          }),
          version({
            version: "1.5.0",
            recommended: false,
            installState: { status: "installed" },
          }),
        ],
        managedOverrides: null,
      });

      await user.click(screen.getByRole("button", { name: "Use" }));
      const notice = screen.getByTestId("version-row-notice");
      expect(notice.textContent).toMatch(expectMatch);
      expect(notice.textContent).not.toMatch(forbid);
    },
  );
});
