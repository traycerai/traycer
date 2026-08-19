import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderManagedVersions,
  ProviderPackVersion,
} from "@traycer/protocol/host/provider-schemas";
import { ProviderPackVersionManagerPanel } from "@/components/settings/panels/provider-pack-version-manager-panel";
import { PROVIDER_PACK_VERSION_MANAGER_CAPABILITY_METHODS } from "@/components/settings/panels/provider-pack-version-manager-capability";
import { tooltipTextNear } from "@/components/ui/__tests__/tooltip-probe";

type UsePackVersionVariables = {
  readonly packId: string;
  readonly version: string | null;
};

type UsePackVersionRefusalCode =
  "verification-failed" | "below-security-floor" | "host-ineligible";

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

/**
 * Which capability methods the panel asked about for one host, deduplicated
 * and in ask order.
 *
 * The gate asks once per pack-version RPC, so the old "last call" assertion
 * would stay green if three of the four stopped being consulted — the exact
 * regression that let a host advertising a strict subset light up controls
 * whose calls deterministically return unsupported-method.
 */
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
  "is-current" | "holder-reserved" | "quarantine-reserved" | "deferred-locked";

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

const mocks = vi.hoisted(() => {
  const supportByHostId = new Map<string, boolean | null>();
  let lastSupportArgs: HostMethodSupportArgs | null = null;
  let supportCalls: HostMethodSupportArgs[] = [];
  let defaultSupport: boolean | null = true;
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
      if (value === null) supportCalls = [];
    },
    /**
     * EVERY capability question the panel asked, in order. The gate asks one
     * per pack-version RPC now, so asserting only the last call would let three
     * of the four silently stop being consulted.
     */
    get supportCalls() {
      return supportCalls;
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
    mocks.supportCalls.push({ hostId, method });
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

/** Row action buttons are icon-only; their accessible name carries the version. */
function rowActionName(label: string, version: string): string {
  return `${label} ${version}`;
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
    // The row used to carry a `condemned-no-retry` sentence that repeated the
    // meta line directly above it, then later a hover-card detail. Both are
    // gone; the reason is now the row's own trouble line, and "no retry" is
    // still carried by the ABSENCE of the button.
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
    // Both flags are set. The row used to render both badges plus a meta line
    // that said "pairs with this Traycer release" a third time; both the
    // second badge and the meta line are gone now, with no replacement
    // surface — a current row simply does not say "recommended" anywhere.
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
    // Composition: allow-list denies retry AND download eligibility denies —
    // no actionable install-fetch button under either label.
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

  // The regression this exists for: a clear-pin refusal used to be reported
  // through a notice keyed by the PINNED VERSION and rendered inside
  // `VersionRow`, so it vanished whenever that version had no row - and then
  // through the update banner, which only mounts when an update is pending.
  // Both dropped the message in the case that matters most, and the user saw a
  // click that did nothing. `updateAvailable` is deliberately null here.
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

    // Certification and install-state are independent axes. This row wears
    // the Unpublished chip (certification) AND states its install trouble
    // inline (install-state) — the two must not collapse into one claim.
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
    // Formerly this failed closed on the missing baseline. The client no
    // longer does baseline math: the host refuses the signed ineligibilities
    // server-side, and those arrive as row certification - absent here, so
    // the installed retained version is honestly selectable.
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

    // Keyboard activation, because that is the path that breaks: arming
    // unmounts the trash button, so without the mount-focus the second press
    // lands on <body> and the two-step flow is unreachable without a mouse.
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
    // The panel is mounted unkeyed under a scope whose host can auto-follow
    // while the popover is open. If the arming were a bare version string it
    // would survive the move, and the new host's identical row would mount
    // already armed — one press from deleting on a machine nothing was armed
    // on. Same pack, same version, different host: must NOT be armed.
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
});

/**
 * The list is a list. Everything a version says about itself beyond "here I
 * am, here is my one state, here is the button" lives in its hover card.
 *
 * Reported from the running app: the dropdown carried version + three badges +
 * a meta line repeating two of them + a Delete, per row.
 */
describe("ProviderPackVersionManagerPanel: row density", () => {
  // This file's other `afterEach(cleanup)` is scoped INSIDE its describe, so a
  // new top-level block gets none and every render accumulates in the same
  // document - which surfaces as "Found multiple elements", not as a leak.
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
    // The row action column is icon-only now; the bare number must not read
    // as "no button" — the download control still has to be there.
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
    // `uncertified` used to earn no chip at all (informational, stays
    // installed and usable). It earns one now: it is the one state that
    // decides whether a delete can be undone, which outranks a mere
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
    // THE REPORTED ROW. On a current row the reversibility question the
    // Unpublished chip exists to flag does not apply — delete is already
    // disabled for the current version — so the chip goes unsaid.
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
