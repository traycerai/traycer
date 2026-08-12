import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderManagedVersions,
  ProviderPackVersion,
} from "@traycer/protocol/host/provider-schemas";
import { ProviderPackVersionManagerPanel } from "@/components/settings/panels/provider-pack-version-manager-panel";
import { PROVIDER_PACK_VERSION_MANAGER_CAPABILITY_METHODS } from "@/components/settings/panels/provider-pack-version-manager-capability";

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

/**
 * The row's details, as a screen reader gets them.
 *
 * THROWS rather than `?? ""`: an absent aria-label is the exact regression
 * these assertions exist to catch (Radix keeps hover-card content out of the
 * a11y tree, so the label is the only form a screen reader ever sees), and a
 * fallback would turn that into a passing test against an empty string.
 */
function detailsLabel(version: string): string {
  const label = screen
    .getByTestId(`version-details-trigger-${version}`)
    .getAttribute("aria-label");
  if (label === null) {
    throw new Error(`version ${version} rendered no details aria-label`);
  }
  return label;
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
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();

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

  it("states a condemned install in the row's details and hides Retry", () => {
    // The row used to carry a `condemned-no-retry` sentence that repeated the
    // meta line directly above it. The state is stated once now, in the
    // details; "no retry" is carried by the ABSENCE of the button, which this
    // still pins.
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

    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
    expect(detailsLabel("1.0.0")).toMatch(/permanently/i);
  });

  it("wears ONE chip — Current outranks Recommended rather than stacking", () => {
    // Both flags are set. The row used to render both badges plus a meta line
    // that said "pairs with this Traycer release" a third time. One chip; the
    // rest is in the details.
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
    // Not lost — demoted.
    expect(detailsLabel("1.2.0")).toMatch(/pairs with this Traycer release/iu);
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

    // The composed meta now lives in the row's details rather than as a line
    // under the version. Read through the accessible name, which is the same
    // string the hover card renders — and the only form a screen reader gets,
    // since Radix keeps hover-card content out of the a11y tree.
    const text = detailsLabel("1.1.0");
    expect(text.length).toBeGreaterThan(0);
    expect(text.toLowerCase()).toMatch(/not necessarily damaged/);
    expect(text.toLowerCase()).not.toMatch(/still usable/);
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

    const useButton = screen.getByRole("button", { name: "Use" });
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

  it("opens the details card on focus and renders the composed meta", async () => {
    // The a11y-name assertions elsewhere would ALL still pass if the card
    // never rendered. This is the one that proves the visible surface exists.
    renderPanel({
      hostId: "host-1",
      available: [
        version({
          version: "1.2.0",
          recommended: true,
          sizeBytes: 40 * 1024 * 1024,
          installState: { status: "installed" },
        }),
      ],
      managedOverrides: null,
    });

    screen.getByTestId("version-details-trigger-1.2.0").focus();
    const card = await screen.findByTestId("version-details-1.2.0");
    expect(card.textContent).toMatch(/Installed/u);
    expect(card.textContent).toMatch(/40 MB/u);
    expect(card.textContent).toMatch(/pairs with this Traycer release/iu);
  });

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
    expect(row.textContent).toBe("1.2.0Download");
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

  it("demotes 'No longer published' out of the row and into the details", () => {
    // THE REPORTED ROW. `uncertified` is informational — the copy stays
    // installed and stays usable — and it was the loudest thing on a healthy
    // row, stated twice: once as a badge, once inside the meta line.
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

    const row = screen.getByTestId("provider-pack-version-row-0.147.0");
    expect(row.textContent).not.toMatch(/No longer published/u);
    expect(screen.getByTestId("version-row-chip-current")).toBeTruthy();
    expect(detailsLabel("0.147.0")).toMatch(/No longer published/u);
  });
});
