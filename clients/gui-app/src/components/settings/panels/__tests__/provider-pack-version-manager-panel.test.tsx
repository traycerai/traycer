import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderManagedVersions,
  ProviderPackVersion,
  ProvidersRefreshPackDiscoveryRequest,
  ProvidersRefreshPackDiscoveryResult,
} from "@traycer/protocol/host/provider-schemas";
import { ProviderPackVersionManagerPanel } from "@/components/settings/panels/provider-pack-version-manager-panel";
import { PROVIDER_PACK_VERSION_MANAGER_CAPABILITY_METHODS } from "@/components/settings/panels/provider-pack-version-manager-capability";
import { tooltipTextNear } from "@/components/ui/__tests__/tooltip-probe";

type UsePackVersionVariables = {
  readonly packId: string;
  readonly version: string | null;
};

type UsePackVersionRefusalCode =
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

/** The gate asks once per pack-version RPC, so the old "last call" assertion would stay green if three of the
 * four stopped being consulted. */
function methodsAskedFor(hostId: string | null): readonly string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const call of mocks.supportCalls) {
    if (call.hostId !== hostId || seen.has(call.method)) continue;
    seen.add(call.method);
    ordered.push(call.method);
  }
  return ordered;
}

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
            | "below-security-floor"
            | "host-ineligible"
            | "yanked";
          readonly detail: string | null;
        };
  }) => void;
  readonly onSettled?: () => void;
  readonly onError?: (error: unknown) => void;
};

type RemovePackVersionVariables = {
  readonly packId: string;
  readonly version: string;
};

type RemovePackVersionRefusalCode =
  | "is-current"
  | "holder-reserved"
  | "quarantine-reserved"
  | "deferred-locked";

type RemoveMutateOptions = {
  readonly onSuccess?: (response: {
    readonly result:
      | { readonly ok: true }
      | {
          readonly ok: false;
          readonly code: RemovePackVersionRefusalCode;
          readonly detail: string | null;
        };
  }) => void;
  readonly onSettled?: () => void;
  readonly onError?: (error: unknown) => void;
};

type SetPackPolicyVariables = {
  readonly packId: string;
  readonly autoDownload: boolean;
};

// The local unions this replaces would have kept compiling after an enum or field change on the wire while
// silently no longer describing it - which is the one thing a mock of a wire-shaped call must not do.
type CheckMutateOptions = {
  readonly onSuccess?: (response: {
    readonly result: ProvidersRefreshPackDiscoveryResult;
  }) => void;
  readonly onSettled?: () => void;
};

const mocks = vi.hoisted(() => {
  const supportByHostId = new Map<string, boolean | null>();
  // `providers.refreshPackDiscovery` is gated through `useHostSupportsMethod` directly, not through the
  // four-method array.
  const supportByMethodOverride = new Map<string, boolean>();
  let lastSupportArgs: HostMethodSupportArgs | null = null;
  let supportCalls: HostMethodSupportArgs[] = [];
  let defaultSupport: boolean | null = true;
  // Without this, a test cannot prove an explicit override is what enables the discovery check, since
  // `defaultSupport` already defaults to `true` for the capability gate.
  let defaultDiscoverySupport = true;
  let installIsPending = false;
  let removeIsPending = false;
  let useIsPending = false;
  let setPolicyIsPending = false;
  let checkIsPending = false;
  return {
    installMutate:
      vi.fn<
        (
          variables: InstallPackVersionVariables,
          options: InstallMutateOptions,
        ) => void
      >(),
    removeMutate:
      vi.fn<
        (
          variables: RemovePackVersionVariables,
          options: RemoveMutateOptions,
        ) => void
      >(),
    useMutate:
      vi.fn<
        (variables: UsePackVersionVariables, options: UseMutateOptions) => void
      >(),
    setPolicyMutate: vi.fn<(variables: SetPackPolicyVariables) => void>(),
    checkMutate:
      vi.fn<
        (
          variables: ProvidersRefreshPackDiscoveryRequest,
          options: CheckMutateOptions,
        ) => void
      >(),
    /** The gate must consult the *passed* hostId, not an ambient default - regressions would re-introduce
     * scoped-host bugs. */
    get supportByHostId() {
      return supportByHostId;
    },
    get supportByMethodOverride() {
      return supportByMethodOverride;
    },
    get lastSupportArgs() {
      return lastSupportArgs;
    },
    set lastSupportArgs(value: HostMethodSupportArgs | null) {
      lastSupportArgs = value;
      if (value === null) supportCalls = [];
    },
    /** The gate asks one per pack-version RPC now, so asserting only the last call would let three of the four
     * silently stop being consulted. */
    get supportCalls() {
      return supportCalls;
    },
    get defaultSupport() {
      return defaultSupport;
    },
    set defaultSupport(value: boolean | null) {
      defaultSupport = value;
    },
    get defaultDiscoverySupport() {
      return defaultDiscoverySupport;
    },
    set defaultDiscoverySupport(value: boolean) {
      defaultDiscoverySupport = value;
    },
    get installIsPending() {
      return installIsPending;
    },
    set installIsPending(value: boolean) {
      installIsPending = value;
    },
    get removeIsPending() {
      return removeIsPending;
    },
    set removeIsPending(value: boolean) {
      removeIsPending = value;
    },
    get useIsPending() {
      return useIsPending;
    },
    set useIsPending(value: boolean) {
      useIsPending = value;
    },
    get setPolicyIsPending() {
      return setPolicyIsPending;
    },
    set setPolicyIsPending(value: boolean) {
      setPolicyIsPending = value;
    },
    get checkIsPending() {
      return checkIsPending;
    },
    set checkIsPending(value: boolean) {
      checkIsPending = value;
    },
  };
});

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSchemaVersion: () => null,
  useHostMethodSupport: (hostId: string | null, method: string) => {
    mocks.lastSupportArgs = { hostId, method };
    mocks.supportCalls.push({ hostId, method });
    if (hostId === null) return null;
    if (mocks.supportByHostId.has(hostId)) {
      return mocks.supportByHostId.get(hostId) ?? null;
    }
    return mocks.defaultSupport;
  },
  // That map is the four-method gate's knob and is host-scoped, so honouring it here would let a future test set
  // `supportByHostId.set("host-1", true)` alongside `defaultDiscoverySupport = false` and silently get a button.
  useHostSupportsMethod: (hostId: string | null, method: string) => {
    if (hostId === null) return false;
    const overrideKey = `${hostId}::${method}`;
    if (mocks.supportByMethodOverride.has(overrideKey)) {
      return mocks.supportByMethodOverride.get(overrideKey) === true;
    }
    return mocks.defaultDiscoverySupport;
  },
}));

vi.mock(
  "@/hooks/providers/use-providers-install-pack-version-mutation",
  () => ({
    useProvidersInstallPackVersion: () => ({
      mutate: mocks.installMutate,
      isPending: mocks.installIsPending,
    }),
  }),
);

vi.mock("@/hooks/providers/use-providers-remove-pack-version-mutation", () => ({
  useProvidersRemovePackVersion: () => ({
    mutate: mocks.removeMutate,
    isPending: mocks.removeIsPending,
  }),
}));

vi.mock("@/hooks/providers/use-providers-use-pack-version-mutation", () => ({
  useProvidersUsePackVersion: () => ({
    mutate: mocks.useMutate,
    isPending: mocks.useIsPending,
  }),
}));

vi.mock("@/hooks/providers/use-providers-set-pack-policy-mutation", () => ({
  useProvidersSetPackPolicy: () => ({
    mutate: mocks.setPolicyMutate,
    isPending: mocks.setPolicyIsPending,
  }),
}));

vi.mock(
  "@/hooks/providers/use-providers-refresh-pack-discovery-mutation",
  () => ({
    useProvidersRefreshPackDiscovery: () => ({
      mutate: mocks.checkMutate,
      isPending: mocks.checkIsPending,
    }),
  }),
);

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

function rowActionName(label: string, version: string): string {
  return `${label} ${version}`;
}

/** The notice it produces is the opposite case and stays on `getByTestId`. */
const CHECK_BUTTON_NAME = "Check for updates";

describe("<ProviderPackVersionManagerPanel /> install-state surfaces", () => {
  afterEach(() => {
    cleanup();
    mocks.installMutate.mockReset();
    mocks.removeMutate.mockReset();
    mocks.useMutate.mockReset();
    mocks.setPolicyMutate.mockReset();
    mocks.checkMutate.mockReset();
    mocks.supportByHostId.clear();
    mocks.supportByMethodOverride.clear();
    mocks.lastSupportArgs = null;
    mocks.defaultSupport = true;
    mocks.defaultDiscoverySupport = true;
    mocks.installIsPending = false;
    mocks.removeIsPending = false;
    mocks.useIsPending = false;
    mocks.setPolicyIsPending = false;
    mocks.checkIsPending = false;
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
    expect(methodsAskedFor(null)).toEqual([
      ...PROVIDER_PACK_VERSION_MANAGER_CAPABILITY_METHODS,
    ]);
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

    expect(methodsAskedFor("host-B")).toEqual([
      ...PROVIDER_PACK_VERSION_MANAGER_CAPABILITY_METHODS,
    ]);
    expect(
      screen.getByTestId("provider-pack-version-manager-unsupported"),
    ).toBeTruthy();
    expect(screen.queryByTestId("provider-pack-version-manager")).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: rowActionName("Download", "1.0.0"),
      }),
    ).toBeNull();

    cleanup();
    mocks.lastSupportArgs = null;

    renderPanel({
      hostId: "host-A",
      available: [version({ version: "1.0.0" })],
      managedOverrides: null,
    });
    expect(methodsAskedFor("host-A")).toEqual([
      ...PROVIDER_PACK_VERSION_MANAGER_CAPABILITY_METHODS,
    ]);
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
    expect(
      screen.queryByRole("button", {
        name: rowActionName("Download", "1.0.0"),
      }),
    ).toBeNull();
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
    expect(
      screen.queryByRole("button", {
        name: rowActionName("Download", "1.0.0"),
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: rowActionName("Use", "1.0.0") }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: rowActionName("Delete", "1.0.0") }),
    ).toBeNull();
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
    // The row's action column is icon-only now; "in progress" is carried by
    // the disabled "Downloading <version>" button, not by row text.
    const downloadingButton = screen.getByRole("button", {
      name: "Downloading 1.4.0",
    });
    expect(downloadingButton.hasAttribute("disabled")).toBe(true);
    // Row meta should describe progress, not a permanent/destructive failure.
    // textContent is typed non-null on HTMLElement; assert the real string.
    const row = screen.getByTestId("provider-pack-version-row-1.4.0");
    expect(row.textContent).not.toMatch(
      /failed permanently|Install failed permanently/i,
    );
    expect(
      screen.queryByRole("button", { name: rowActionName("Retry", "1.4.0") }),
    ).toBeNull();
  });

  it("hides Retry/Download for a condemned install and states the reason inline", () => {
    // Both are gone; the reason is now the row's own trouble line, and "no retry" is still carried by the absence
    // of the button.
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

    expect(
      screen.queryByRole("button", { name: rowActionName("Retry", "1.0.0") }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: rowActionName("Download", "1.0.0"),
      }),
    ).toBeNull();
    const trouble = screen.getByTestId("version-row-trouble");
    expect(trouble.textContent).toMatch(/permanently/i);
  });

  it("wears ONE chip — Current outranks Recommended rather than stacking", () => {
    // Both flags are set.
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

    expect(screen.getByTestId("version-row-chip-current").textContent).toBe(
      "Current",
    );
    expect(screen.queryByTestId("version-row-chip-recommended")).toBeNull();
    const row = screen.getByTestId("provider-pack-version-row-1.2.0");
    expect(row.textContent).not.toMatch(/Recommended/u);
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
    // Composition: allow-list denies retry and download eligibility denies - no actionable install-fetch button
    // under either label.
    expect(
      screen.queryByRole("button", {
        name: rowActionName("Download", "1.0.0"),
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: rowActionName("Retry", "1.0.0") }),
    ).toBeNull();
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

    expect(
      screen.getByRole("button", { name: rowActionName("Retry", "1.0.0") }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: rowActionName("Download", "1.0.0"),
      }),
    ).toBeNull();
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

  // `updateAvailable` is deliberately null here.
  it("shows a clear-pin refusal even with no update pending and no row for the pinned version", async () => {
    const user = userEvent.setup();
    mocks.useMutate.mockImplementation((_variables, options) => {
      options.onSuccess?.({
        result: {
          ok: false,
          code: "below-security-floor",
          detail: "operator detail that must not be the user sentence",
        },
      });
      options.onSettled?.();
    });

    renderPanel({
      hostId: "host-1",
      // 9.9.9 is pinned and is NOT in `available`, so no row can carry the
      // notice - the exact state a user clears a pin from.
      available: [
        version({
          version: "1.2.0",
          current: true,
          installState: { status: "installed" },
        }),
      ],
      managedOverrides: {
        pinnedVersion: "9.9.9",
        updateAvailable: null,
        autoDownload: false,
      },
    });

    await user.click(screen.getByTestId("provider-pack-clear-pin"));

    const notice = screen.getByTestId("provider-pack-pin-notice");
    // Mapped copy, not the raw host `detail` - operator strings are never the
    // primary sentence.
    expect(notice.textContent).toMatch(/security minimum/iu);
    expect(notice.textContent).not.toMatch(/operator detail/iu);
    expect(
      screen.queryByTestId("provider-pack-update-available-banner"),
    ).toBeNull();
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

    // This row wears the Unpublished chip (certification) and states its install trouble inline (install-state) -
    // the two must not collapse into one claim.
    expect(screen.getByTestId("version-row-chip-unpublished").textContent).toBe(
      "Unpublished",
    );
    const trouble = screen.getByTestId("version-row-trouble");
    expect(trouble.textContent.toLowerCase()).toMatch(
      /not necessarily damaged/,
    );
    expect(trouble.textContent.toLowerCase()).not.toMatch(/still usable/);
  });

  it("offers Use on an installed non-current version even offline with no recommended row (D1 as revised 2026-08-12)", () => {
    // Formerly this failed closed on the missing baseline.
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

    const useButton = screen.getByRole("button", {
      name: rowActionName("Use", "1.0.0"),
    });
    expect(useButton.hasAttribute("disabled")).toBe(false);
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

    await user.click(
      screen.getByRole("button", {
        name: rowActionName("Download", "1.5.0"),
      }),
    );
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

      await user.click(
        screen.getByRole("button", { name: rowActionName("Use", "1.5.0") }),
      );
      const notice = screen.getByTestId("version-row-notice");
      expect(notice.textContent).toMatch(expectMatch);
      expect(notice.textContent).not.toMatch(forbid);
    },
  );

  it("arms delete on the first click and only removes on the confirming click", async () => {
    const user = userEvent.setup();
    renderPanel({
      hostId: "host-1",
      available: [
        version({ version: "1.5.0", installState: { status: "installed" } }),
      ],
      managedOverrides: null,
    });

    await user.click(
      screen.getByRole("button", { name: rowActionName("Delete", "1.5.0") }),
    );

    expect(mocks.removeMutate).not.toHaveBeenCalled();
    const confirm = screen.getByTestId("version-delete-confirm-1.5.0");
    expect(confirm).toBeTruthy();

    await user.click(confirm);

    expect(mocks.removeMutate).toHaveBeenCalledTimes(1);
    expect(mocks.removeMutate.mock.calls[0]?.[0]).toEqual({
      packId: "opencode",
      version: "1.5.0",
    });
  });

  it("keeps focus on the delete control across the arming swap, named by version", async () => {
    const user = userEvent.setup();
    renderPanel({
      hostId: "host-1",
      available: [
        version({ version: "1.5.0", installState: { status: "installed" } }),
        version({ version: "2.0.0", installState: { status: "installed" } }),
      ],
      managedOverrides: null,
    });

    // Keyboard activation, because that is the path that breaks: arming unmounts the trash button, so without the
    // mount-focus the second press lands on <body> and the two-step flow is unreachable without a mouse.
    const trash = screen.getByRole("button", {
      name: rowActionName("Delete", "1.5.0"),
    });
    trash.focus();
    await user.keyboard("{Enter}");

    const confirm = screen.getByTestId("version-delete-confirm-1.5.0");
    expect(document.activeElement).toBe(confirm);
    expect(confirm.getAttribute("aria-label")).toBe("Confirm delete 1.5.0");

    await user.keyboard("{Enter}");

    expect(mocks.removeMutate).toHaveBeenCalledTimes(1);
    expect(mocks.removeMutate.mock.calls[0]?.[0]).toEqual({
      packId: "opencode",
      version: "1.5.0",
    });
  });

  it("disarms a delete when the settings scope follows to another host carrying the same version", async () => {
    // Same pack, same version, different host: must not be armed.
    const user = userEvent.setup();
    const rows = [
      version({ version: "1.5.0", installState: { status: "installed" } }),
    ];
    const view = render(
      <ProviderPackVersionManagerPanel
        hostId="host-1"
        packId="opencode"
        packDisplayName="opencode CLI"
        managedVersions={managed(rows, null)}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: rowActionName("Delete", "1.5.0") }),
    );
    expect(screen.getByTestId("version-delete-confirm-1.5.0")).toBeTruthy();

    view.rerender(
      <ProviderPackVersionManagerPanel
        hostId="host-2"
        packId="opencode"
        packDisplayName="opencode CLI"
        managedVersions={managed(rows, null)}
      />,
    );

    expect(screen.queryByTestId("version-delete-confirm-1.5.0")).toBeNull();
    expect(
      screen.getByRole("button", { name: rowActionName("Delete", "1.5.0") }),
    ).toBeTruthy();
    expect(mocks.removeMutate).not.toHaveBeenCalled();
  });

  it("says why the CURRENT version is blocked, since its chip slot is taken by Current", () => {
    renderPanel({
      hostId: "host-1",
      available: [
        version({
          version: "1.5.0",
          current: true,
          certification: "yanked",
          installState: { status: "installed" },
        }),
      ],
      managedOverrides: null,
    });

    expect(screen.getByText("Current")).toBeTruthy();
    const trouble = screen.getByTestId("version-row-trouble");
    expect(trouble.textContent).toContain("Withdrawn");
  });

  it("disarms an armed delete when another row's action runs", async () => {
    const user = userEvent.setup();
    renderPanel({
      hostId: "host-1",
      available: [
        version({ version: "1.5.0", installState: { status: "installed" } }),
        version({ version: "2.0.0", installState: { status: "installed" } }),
      ],
      managedOverrides: null,
    });

    await user.click(
      screen.getByRole("button", { name: rowActionName("Delete", "1.5.0") }),
    );
    expect(screen.getByTestId("version-delete-confirm-1.5.0")).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: rowActionName("Use", "2.0.0") }),
    );

    expect(mocks.useMutate).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("version-delete-confirm-1.5.0")).toBeNull();
    // Back to its icon shape, not just "the confirm testid is gone".
    expect(
      screen.getByRole("button", { name: rowActionName("Delete", "1.5.0") }),
    ).toBeTruthy();
  });

  it("renders a disabled delete carrying its reason for a quarantined version (regression: used to render no delete control at all)", () => {
    renderPanel({
      hostId: "host-1",
      available: [
        version({
          version: "1.3.0",
          installState: { status: "unusable", reason: "quarantined" },
        }),
      ],
      managedOverrides: null,
    });

    const blocked = screen.getByTestId("delete-disabled-blocked");
    expect(blocked.hasAttribute("disabled")).toBe(true);
    expect(tooltipTextNear(blocked)).toMatch(/quarantine/iu);
  });

  it("renders no delete control at all for a version with nothing on disk", () => {
    renderPanel({
      hostId: "host-1",
      available: [
        version({ version: "1.6.0", installState: { status: "absent" } }),
      ],
      managedOverrides: null,
    });

    expect(screen.queryByTestId("delete-disabled-blocked")).toBeNull();
    expect(
      screen.queryByRole("button", { name: rowActionName("Delete", "1.6.0") }),
    ).toBeNull();
    expect(screen.queryByTestId("version-delete-confirm-1.6.0")).toBeNull();
  });

  it("renders no title and no on-disk footprint even with a non-null totalSizeBytes", () => {
    renderPanel({
      hostId: "host-1",
      available: [
        version({ version: "1.0.0", installState: { status: "installed" } }),
      ],
      managedOverrides: { totalSizeBytes: 123_000_000 },
    });

    const panel = screen.getByTestId("provider-pack-version-manager");
    expect(panel.textContent).not.toMatch(/· versions/u);
    expect(panel.textContent).not.toMatch(/on disk/iu);
  });

  it("still exposes the auto-download switch and toggles the policy", async () => {
    const user = userEvent.setup();
    renderPanel({
      hostId: "host-1",
      available: [
        version({ version: "1.0.0", installState: { status: "installed" } }),
      ],
      managedOverrides: { autoDownload: false },
    });

    const toggle = screen.getByRole("switch", {
      name: "Auto-download updates",
    });
    await user.click(toggle);

    expect(mocks.setPolicyMutate).toHaveBeenCalledTimes(1);
    expect(mocks.setPolicyMutate.mock.calls[0]?.[0]).toEqual({
      packId: "opencode",
      autoDownload: true,
    });
  });

  it("hides Check for updates when the host has the version manager but not the discovery RPC, and keeps the auto-download row's original full-width layout", () => {
    // The discriminating shape: all four PROVIDER_PACK_VERSION_MANAGER_CAPABILITY_METHODS answer true (the panel
    // itself renders), while providers.refreshPackDiscovery answers false.
    mocks.defaultSupport = true;
    mocks.supportByMethodOverride.set(
      "host-1::providers.refreshPackDiscovery",
      false,
    );
    renderPanel({
      hostId: "host-1",
      available: [version({ version: "1.0.0" })],
      managedOverrides: null,
    });

    expect(screen.getByTestId("provider-pack-version-manager")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: CHECK_BUTTON_NAME }),
    ).toBeNull();
    // : with the button absent the label must keep the band's original layout - every host older than this
    // release, for as long as it stays older.
    const label = screen
      .getByRole("switch", { name: "Auto-download updates" })
      .closest("label");
    expect(label).not.toBeNull();
    expect(label?.classList.contains("w-full")).toBe(true);
    expect(label?.classList.contains("justify-between")).toBe(true);
    expect(label?.classList.contains("ml-auto")).toBe(false);
    // The row must be able to wrap.
    expect(label?.parentElement?.classList.contains("flex-wrap")).toBe(true);
  });

  it("shows Check for updates when the host supports the discovery RPC, and clusters the auto-download row against the right edge", () => {
    // Discriminating in the opposite direction: `defaultDiscoverySupport` starts this test false, so the override
    // below is what makes the button appear - not an ambient default that already reads true.
    mocks.defaultSupport = true;
    mocks.defaultDiscoverySupport = false;
    mocks.supportByMethodOverride.set(
      "host-1::providers.refreshPackDiscovery",
      true,
    );
    renderPanel({
      hostId: "host-1",
      available: [version({ version: "1.0.0" })],
      managedOverrides: null,
    });

    expect(
      screen.getByRole("button", { name: CHECK_BUTTON_NAME }),
    ).toBeTruthy();
    // F3: with the button present the label clusters right; the switch never
    // moves, only the label's text does.
    const label = screen
      .getByRole("switch", { name: "Auto-download updates" })
      .closest("label");
    expect(label).not.toBeNull();
    expect(label?.classList.contains("ml-auto")).toBe(true);
    // Token membership, not substring: `className.toContain("justify-between")`
    // would also match a `sm:justify-between` someone adds later.
    expect(label?.classList.contains("w-full")).toBe(false);
    expect(label?.classList.contains("justify-between")).toBe(false);
    // Right-edge clustering and wrapping are not alternatives: the row wraps in both branches, and this is the
    // branch where it has two children to fit rather than one.
    expect(label?.parentElement?.classList.contains("flex-wrap")).toBe(true);
  });

  it.each([
    {
      label: "pack",
      next: { hostId: "host-1", packId: "codex" },
    },
    {
      label: "host",
      next: { hostId: "host-2", packId: "opencode" },
    },
  ])(
    "drops a check result that lands after the panel changed $label",
    async ({ next }) => {
      const user = userEvent.setup();
      // A check is budgeted minutes because it can join the host's whole discovery tick. Over that window this
      // unkeyed panel can be re-pointed at another pack, or auto-follow to another host, without remounting.
      const deliver: Array<
        (response: {
          readonly result: ProvidersRefreshPackDiscoveryResult;
        }) => void
      > = [];
      mocks.checkMutate.mockImplementation((_variables, options) => {
        if (options.onSuccess !== undefined) deliver.push(options.onSuccess);
      });

      const { rerender } = render(
        <ProviderPackVersionManagerPanel
          hostId="host-1"
          packId="opencode"
          packDisplayName="opencode CLI"
          managedVersions={managed([version({ version: "1.0.0" })], null)}
        />,
      );
      await user.click(screen.getByRole("button", { name: CHECK_BUTTON_NAME }));
      expect(deliver).toHaveLength(1);

      rerender(
        <ProviderPackVersionManagerPanel
          hostId={next.hostId}
          packId={next.packId}
          packDisplayName="another CLI"
          managedVersions={managed([version({ version: "1.0.0" })], null)}
        />,
      );

      // `unusable` on purpose: the loudest sentence on this surface, and the one whose claim ("this pack's update
      // knowledge was cleared") would be flatly false about the pack now on screen.
      act(() => {
        deliver[0]?.({ result: { ok: true, outcome: "unusable" } });
      });

      expect(
        screen.queryByTestId("provider-pack-discovery-check-notice"),
      ).toBeNull();
      // And nothing is announced either - the stale result must not reach the live region any more than the visible
      // line.
      expect(screen.getByRole("status").textContent).toBe("");
    },
  );

  it("keeps the new pack's check button usable while the old pack's check is still in flight", async () => {
    const user = userEvent.setup();
    mocks.checkMutate.mockImplementation(() => {
      // Never settles: the request is still joined to the host's tick.
    });

    const { rerender } = render(
      <ProviderPackVersionManagerPanel
        hostId="host-1"
        packId="opencode"
        packDisplayName="opencode CLI"
        managedVersions={managed([version({ version: "1.0.0" })], null)}
      />,
    );
    await user.click(screen.getByRole("button", { name: CHECK_BUTTON_NAME }));

    // The mutation is shared by the panel, so its `isPending` says nothing about which pack asked. Only the
    // identity captured at dispatch does.
    mocks.checkIsPending = true;
    rerender(
      <ProviderPackVersionManagerPanel
        hostId="host-1"
        packId="codex"
        packDisplayName="codex CLI"
        managedVersions={managed([version({ version: "1.0.0" })], null)}
      />,
    );

    expect(
      screen
        .getByRole("button", { name: CHECK_BUTTON_NAME })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("does not let a superseded check's settle re-enable the button of the check still running", async () => {
    const user = userEvent.setup();
    // Do not delete it as unreachable without also deleting the guard, and do not read it as evidence the race is
    // live.
    const settles: Array<() => void> = [];
    mocks.checkMutate.mockImplementation((_variables, options) => {
      if (options.onSettled !== undefined) settles.push(options.onSettled);
    });

    const { rerender } = render(
      <ProviderPackVersionManagerPanel
        hostId="host-1"
        packId="opencode"
        packDisplayName="opencode CLI"
        managedVersions={managed([version({ version: "1.0.0" })], null)}
      />,
    );
    await user.click(screen.getByRole("button", { name: CHECK_BUTTON_NAME }));

    mocks.checkIsPending = true;
    rerender(
      <ProviderPackVersionManagerPanel
        hostId="host-1"
        packId="codex"
        packDisplayName="codex CLI"
        managedVersions={managed([version({ version: "1.0.0" })], null)}
      />,
    );
    await user.click(screen.getByRole("button", { name: CHECK_BUTTON_NAME }));
    expect(settles).toHaveLength(2);

    // The first pack's request settles while the second pack's is still running.
    act(() => {
      settles[0]?.();
    });

    // Still disabled: codex's own check has not settled.
    expect(
      screen
        .getByRole("button", { name: CHECK_BUTTON_NAME })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("disables the check button while another panel action is pending", () => {
    mocks.installIsPending = true;
    renderPanel({
      hostId: "host-1",
      available: [version({ version: "1.0.0" })],
      managedOverrides: null,
    });

    const checkButton = screen.getByRole("button", { name: CHECK_BUTTON_NAME });
    expect(checkButton.hasAttribute("disabled")).toBe(true);
  });

  it("keeps rows and the auto-download switch enabled while a check is pending, but disables the check button itself", async () => {
    // The check has to be dispatched rather than just flagged pending: the button disables on the identity
    // captured at dispatch, so a bare `isPending` with nothing in flight is not a state production can reach.
    const user = userEvent.setup();
    mocks.checkIsPending = true;
    mocks.checkMutate.mockImplementation(() => {
      // Never settles - still joined to the host's discovery tick.
    });
    renderPanel({
      hostId: "host-1",
      available: [
        version({ version: "1.5.0", installState: { status: "installed" } }),
      ],
      managedOverrides: { autoDownload: false },
    });
    await user.click(screen.getByRole("button", { name: CHECK_BUTTON_NAME }));

    const useButton = screen.getByRole("button", {
      name: rowActionName("Use", "1.5.0"),
    });
    expect(useButton.hasAttribute("disabled")).toBe(false);

    const toggle = screen.getByRole("switch", {
      name: "Auto-download updates",
    });
    expect(toggle.hasAttribute("disabled")).toBe(false);

    const checkButton = screen.getByRole("button", { name: CHECK_BUTTON_NAME });
    expect(checkButton.hasAttribute("disabled")).toBe(true);
  });

  it.each([
    {
      outcome: "moved" as const,
      expected: "Checked the registry.",
      expectedKind: "info" as const,
    },
    {
      outcome: "unchanged" as const,
      expected: "No changes found.",
      expectedKind: "info" as const,
    },
    {
      outcome: "unreachable" as const,
      expected: "Couldn't reach the registry. Try again later.",
      expectedKind: "error" as const,
    },
    {
      outcome: "unusable" as const,
      expected:
        "The registry's answer couldn't be trusted. This pack's update knowledge was cleared until the next successful check.",
      expectedKind: "error" as const,
    },
  ])(
    "renders the exact notice for the $outcome outcome",
    async ({ outcome, expected, expectedKind }) => {
      const user = userEvent.setup();
      mocks.checkMutate.mockImplementation((_variables, options) => {
        options.onSuccess?.({ result: { ok: true, outcome } });
      });
      renderPanel({
        hostId: "host-1",
        available: [version({ version: "1.0.0" })],
        managedOverrides: null,
      });

      // The live region is permanently mounted and starts empty.
      expect(screen.getByRole("status").textContent).toBe("");

      await user.click(screen.getByRole("button", { name: CHECK_BUTTON_NAME }));

      // F4: what the panel actually sent, not just what happens after.
      expect(mocks.checkMutate.mock.calls[0]?.[0]).toEqual({
        packId: "opencode",
      });

      const notice = screen.getByTestId("provider-pack-discovery-check-notice");
      expect(notice.textContent).toBe(expected);
      // : `kind` decides the visible class; a version that always answers "info" would pass every case above while
      // the two failure sentences render in muted grey.
      expect(notice.className).toContain(
        expectedKind === "error" ? "text-destructive" : "text-muted-foreground",
      );

      // Keep it singular; `getAllByRole(...)[0]` would silently drop that half.
      const live = screen.getByRole("status");
      expect(live.getAttribute("aria-live")).toBe("polite");
      expect(live.classList.contains("sr-only")).toBe(true);
      expect(live.textContent).toBe(expected);
      expect(notice.getAttribute("aria-hidden")).toBe("true");
    },
  );

  it.each([
    {
      code: "discovery-unavailable" as const,
      expected: "Update checks aren't available on this host right now.",
    },
    {
      code: "pack-disabled" as const,
      expected: "Enable this provider to check for updates.",
    },
  ])("renders the $code refusal inline", async ({ code, expected }) => {
    const user = userEvent.setup();
    mocks.checkMutate.mockImplementation((_variables, options) => {
      options.onSuccess?.({ result: { ok: false, code, detail: null } });
    });
    renderPanel({
      hostId: "host-1",
      available: [version({ version: "1.0.0" })],
      managedOverrides: null,
    });

    // Permanent mount, empty before the click - asserted here as well as in the outcome table so each table pins
    // the contract on its own: the post-click query below would find a conditionally mounted region too.
    expect(screen.getByRole("status").textContent).toBe("");

    await user.click(screen.getByRole("button", { name: CHECK_BUTTON_NAME }));

    const notice = screen.getByTestId("provider-pack-discovery-check-notice");
    expect(notice.textContent).toBe(expected);
    // Both refusals are hard policy, never "info".
    expect(notice.className).toContain("text-destructive");
    // A refusal is announced on the same terms as an outcome - see the outcome table above for why one
    // `getByRole("status")` match is also the no-double-announcement pin.
    const live = screen.getByRole("status");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.classList.contains("sr-only")).toBe(true);
    expect(live.textContent).toBe(expected);
    expect(notice.getAttribute("aria-hidden")).toBe("true");
  });

  it("clears the check notice when another panel action starts", async () => {
    const user = userEvent.setup();
    mocks.checkMutate.mockImplementation((_variables, options) => {
      options.onSuccess?.({ result: { ok: true, outcome: "unchanged" } });
    });
    renderPanel({
      hostId: "host-1",
      available: [
        version({ version: "1.5.0", installState: { status: "installed" } }),
      ],
      managedOverrides: { autoDownload: false },
    });

    await user.click(screen.getByRole("button", { name: CHECK_BUTTON_NAME }));
    expect(
      screen.getByTestId("provider-pack-discovery-check-notice").textContent,
    ).toBe("No changes found.");

    await user.click(
      screen.getByRole("switch", { name: "Auto-download updates" }),
    );

    expect(
      screen.queryByTestId("provider-pack-discovery-check-notice"),
    ).toBeNull();
  });
});

/** The list is a list. */
describe("ProviderPackVersionManagerPanel: row density", () => {
  // This file's other `afterEach(cleanup)` is scoped inside its describe, so a new top-level block gets none and
  // every render accumulates in the same document - which surfaces as "Found multiple elements", not as a leak.
  afterEach(cleanup);

  it("keeps a plain published version down to its number and its button", () => {
    // Nothing to say ⇒ no chip, and no details trigger at all: an affordance
    // that opens an empty card is worse than no affordance.
    renderPanel({
      hostId: "host-1",
      available: [
        version({
          version: "1.2.0",
          recommended: false,
          current: false,
          sizeBytes: null,
          installState: { status: "absent" },
        }),
      ],
      managedOverrides: null,
    });

    const row = screen.getByTestId("provider-pack-version-row-1.2.0");
    expect(row.textContent).toBe("1.2.0");
    // The row action column is icon-only now; the bare number must not read as "no button" - the download control
    // still has to be there.
    expect(
      screen.getByRole("button", { name: rowActionName("Download", "1.2.0") }),
    ).toBeTruthy();
  });

  it("gives a yanked row its blocking chip, outranking Recommended", () => {
    // A version you cannot use outranks one we suggest.
    renderPanel({
      hostId: "host-1",
      available: [
        version({
          version: "1.2.0",
          recommended: true,
          certification: "yanked",
          installState: { status: "installed" },
        }),
      ],
      managedOverrides: null,
    });

    expect(screen.getByTestId("version-row-chip-blocked").textContent).toBe(
      "Withdrawn",
    );
    expect(screen.queryByTestId("version-row-chip-recommended")).toBeNull();
  });

  it("gives a non-current uncertified version its Unpublished chip, outranking Recommended", () => {
    // It earns one now: it is the one state that decides whether a delete can be undone, which outranks a mere
    // suggestion.
    renderPanel({
      hostId: "host-1",
      available: [
        version({
          version: "1.1.0",
          recommended: true,
          certification: "uncertified",
          installState: { status: "installed" },
        }),
      ],
      managedOverrides: null,
    });

    expect(screen.getByTestId("version-row-chip-unpublished").textContent).toBe(
      "Unpublished",
    );
    expect(screen.queryByTestId("version-row-chip-recommended")).toBeNull();
  });

  it("suppresses the Unpublished chip on the current row (states Current instead)", () => {
    // On a current row the reversibility question the Unpublished chip exists to flag does not apply - delete is
    // already disabled for the current version - so the chip goes unsaid.
    renderPanel({
      hostId: "host-1",
      available: [
        version({
          version: "0.147.0",
          recommended: true,
          current: true,
          certification: "uncertified",
          installState: { status: "installed" },
        }),
      ],
      managedOverrides: null,
    });

    expect(screen.getByTestId("version-row-chip-current").textContent).toBe(
      "Current",
    );
    expect(screen.queryByTestId("version-row-chip-unpublished")).toBeNull();
    expect(screen.queryByTestId("version-row-chip-recommended")).toBeNull();
  });
});
