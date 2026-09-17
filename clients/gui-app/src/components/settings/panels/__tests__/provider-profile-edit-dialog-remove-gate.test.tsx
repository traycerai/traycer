import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { tooltipTextNear } from "@/components/ui/__tests__/tooltip-probe";

// Same rationale as the sibling panel suites: the dialog pulls in
// mutation/host hooks unconditionally, so those are stubbed to keep this test
// scoped to a QueryClient with no bound host. The gate under test reads only
// `profile.kind`, so none of these participate in it.
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => null };
});
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/hooks/providers/use-remove-provider-profile-mutation", () => ({
  useRemoveProviderProfile: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
}));
vi.mock("@/hooks/providers/use-rename-provider-profile-mutation", () => ({
  useRenameProviderProfile: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
}));
vi.mock("@/hooks/providers/use-recolor-provider-profile-mutation", () => ({
  useRecolorProviderProfile: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
}));
vi.mock("@/hooks/providers/use-refresh-providers", () => ({
  useRefreshProviders: () => () => Promise.resolve(),
}));

import { ProfileEditDialog } from "@/components/settings/panels/provider-profile-edit-dialog";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";

/**
 * The reason string the dialog shows on a profile that cannot be removed.
 * Duplicated rather than imported (it is not exported) so this test fails
 * loudly if the two definitions drift apart.
 */
const AMBIENT_REMOVE_DISABLED_REASON =
  "This profile uses your default CLI login and cannot be removed.";

function profileOfKind(kind: ProviderProfile["kind"]): ProviderProfile {
  return {
    profileId: kind === "ambient" ? "ambient" : "profile-managed",
    enabled: true,
    kind,
    authType: "oauth",
    label: kind === "ambient" ? "Terminal account" : "Work account",
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    identity: { email: null, tier: null, accountUuid: null },
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    accentColor: null,
    ambientDriftNotice: null,
  };
}

function opencodeState(profile: ProviderProfile): ProviderCliState {
  return {
    providerId: "opencode",
    enabled: true,
    disabledBy: null,
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    profiles: [profile],
  };
}

function renderDialogFor(kind: ProviderProfile["kind"]) {
  const profile = profileOfKind(kind);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ProfileEditDialog
          state={opencodeState(profile)}
          profile={profile}
          profiles={[profile]}
          canOauth
          startInReauth={false}
          isLocalHost
          open
          onOpenChange={() => undefined}
          remainingProfilesAfterRemoval={[]}
          onSelectedProfileIdChange={() => undefined}
          profileEnablementAvailable
          profileEnablementPending={() => false}
          onSetProfileEnabled={() => undefined}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/**
 * The remove affordance is gated on `profile.kind` alone
 * (`PROFILE_REMOVE_PRESENTATION`): an ambient profile is the user's default
 * CLI login, which the host does not own and therefore cannot delete, while a
 * managed profile is a directory the host created and can.
 *
 * Parameterised over the kind rather than written twice, so the two arms
 * cannot drift and neither can silently stop exercising its branch - a single
 * arm asserting "disabled" passes just as well against a dialog that disables
 * removal for everything.
 */
describe("<ProfileEditDialog /> remove gate by profile kind", () => {
  afterEach(() => {
    cleanup();
  });

  const cases = [
    {
      kind: "ambient",
      removable: false,
      ariaLabel: `Remove profile. ${AMBIENT_REMOVE_DISABLED_REASON}`,
    },
    { kind: "managed", removable: true, ariaLabel: "Remove profile" },
  ] as const;

  it.each(cases)(
    "a $kind profile's remove button is disabled=$removable-inverted and names its reason",
    ({ kind, removable, ariaLabel }) => {
      renderDialogFor(kind);

      const button = screen.getByRole<HTMLButtonElement>("button", {
        name: ariaLabel,
      });
      // Natively disabled, not merely rejected on click: a disabled control is
      // neither focusable nor exposed as actionable to assistive tech.
      expect(button.disabled).toBe(!removable);
    },
  );

  it("states WHY an ambient profile cannot be removed on hover, not only in the button's accessible name", () => {
    renderDialogFor("ambient");

    const button = screen.getByRole("button", {
      name: `Remove profile. ${AMBIENT_REMOVE_DISABLED_REASON}`,
    });

    // `tooltipTextNear`, not `tooltipTextFor`: the wrapper cannot sit on the
    // button itself (a disabled control fires no focus), so it wraps an
    // intermediate span and the trigger is the button's ANCESTOR.
    //
    // This is the half the accessible name does NOT cover. `ariaLabel` and
    // `disabledReason` are independent fields of `PROFILE_REMOVE_PRESENTATION`
    // - the name is composed from the reason constant directly - so a sighted
    // user reaches the explanation only through this tooltip.
    //
    // Falsification: give the ambient arm's `disabledReason` any OTHER
    // non-null string and this reddens alone - the button stays disabled
    // (`!== null` still holds) and keeps its name, so both arms above stay
    // green. An earlier version of this test asserted the accessible name a
    // second time and called that two properties; it survived exactly this
    // mutation.
    expect(tooltipTextNear(button)).toBe(AMBIENT_REMOVE_DISABLED_REASON);
  });

  it("CONTROL: the managed arm has no reason in its name and no tooltip at all, so the assertions above are about the gate and not the fixture", () => {
    renderDialogFor("managed");

    expect(
      screen.queryByRole("button", {
        name: `Remove profile. ${AMBIENT_REMOVE_DISABLED_REASON}`,
      }),
    ).toBeNull();
    // A null `disabledReason` makes `TooltipWrapper` degrade to a bare
    // `Slot.Root`, so there is no trigger to find - a stronger statement than
    // "some other text", and one that fails if the wrapper ever starts
    // rendering an empty tooltip box here.
    expect(
      tooltipTextNear(screen.getByRole("button", { name: "Remove profile" })),
    ).toBeNull();
  });
});
