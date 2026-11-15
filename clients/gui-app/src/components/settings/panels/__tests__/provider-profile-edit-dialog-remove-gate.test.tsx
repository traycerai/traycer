import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import type { ProfileRecordClient } from "@traycer-clients/shared/host-client/profile-record-actions";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { tooltipTextNear } from "@/components/ui/__tests__/tooltip-probe";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";

const fixture = vi.hoisted(() => ({
  offersSignIns: false,
  bindingAnswer: "bound" as
    | "bound"
    | "own_settings"
    | "pending"
    | "failed"
    | "empty",
  bindingRefetch: vi.fn(),
  auth: {
    signOutProfileRecord: vi.fn<ProfileRecordClient["signOutProfileRecord"]>(),
    removeProfileRecord: vi.fn<ProfileRecordClient["removeProfileRecord"]>(),
  },
  client: null as HostClient<HostRpcRegistry> | null,
  localRemove: vi.fn(),
  openChanges: [] as boolean[],
  selectedProfileIds: [] as Array<string | null>,
  remainingProfiles: [] as ProviderProfile[],
}));

// The dialog's unrelated local-profile mutations remain stubbed. Record
// actions run through the real consumer hook with fakes at the AuthService and
// per-computer binding-query boundaries.
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => fixture.client,
    useAuthService: () => fixture.auth,
  };
});
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({
    data: fixture.offersSignIns ? { offersSignIns: true } : undefined,
  }),
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => false,
  useHostMethodSupport: () => true,
}));
vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersion: () => ({ major: 1, minor: 0 }),
}));
vi.mock("@/hooks/bots/use-environment-host-read-query", () => ({
  useEnvironmentHostReadQuery: () => {
    if (fixture.bindingAnswer === "own_settings")
      return { kind: "own_settings" };
    if (fixture.bindingAnswer === "pending") return { kind: "pending" };
    if (fixture.bindingAnswer === "failed") {
      return { kind: "failed", retry: vi.fn() };
    }
    return {
      kind: "binding",
      query: {
        data:
          fixture.bindingAnswer === "bound"
            ? { environment: { environmentId: "bound-environment" } }
            : undefined,
        refetch: fixture.bindingRefetch,
      },
    };
  },
}));
vi.mock("@/hooks/providers/use-remove-provider-profile-mutation", () => ({
  useRemoveProviderProfile: () => ({
    mutate: fixture.localRemove,
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
vi.mock("@/hooks/providers/use-name-profile-record-mutation", () => ({
  useNameProfileRecordForClient: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
}));
vi.mock("@/hooks/providers/use-account-profile-recolor", () => ({
  useAccountProfileRecolorForClient: () => ({
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

function renderDialog(profile: ProviderProfile) {
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
          oauthUnavailableHint={null}
          startInReauth={false}
          isLocalHost
          open
          onOpenChange={(nextOpen) => {
            fixture.openChanges.push(nextOpen);
          }}
          remainingProfilesAfterRemoval={fixture.remainingProfiles}
          onSelectedProfileIdChange={(profileId) => {
            fixture.selectedProfileIds.push(profileId);
          }}
          profileEnablementAvailable
          profileEnablementPending={() => false}
          onSetProfileEnabled={() => undefined}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function installClient() {
  let requestId = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => {
      requestId += 1;
      return `req-profile-remove-${String(requestId)}`;
    },
    handlers: {},
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "synthetic-profile-remove-test",
    }),
  );
  fixture.client = spine.createRequester(mockLocalHostEntry);
  return messenger;
}

function storedToastTitles(): unknown[] {
  return toast
    .getToasts()
    .flatMap((entry) => ("title" in entry ? [entry.title] : []));
}

function renderDialogFor(kind: ProviderProfile["kind"]) {
  return renderDialog(profileOfKind(kind));
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
  beforeEach(() => {
    fixture.offersSignIns = false;
    fixture.bindingAnswer = "bound";
    fixture.bindingRefetch.mockReset();
    fixture.auth.signOutProfileRecord.mockReset().mockResolvedValue({
      kind: "ok",
      profileId: "profile-managed",
      harnessId: "opencode",
      recordRevision: "record-rev-1",
    });
    fixture.auth.removeProfileRecord.mockReset().mockResolvedValue({
      kind: "ok",
      profileId: "profile-managed",
      harnessId: "opencode",
      recordRevision: "record-rev-1",
    });
    fixture.client = null;
    fixture.localRemove.mockReset();
    fixture.openChanges = [];
    fixture.selectedProfileIds = [];
    fixture.remainingProfiles = [];
  });

  afterEach(() => {
    cleanup();
    toast.dismiss();
    fixture.offersSignIns = false;
    fixture.client = null;
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

  it("keeps the existing local Remove confirmation when offersSignIns is absent", () => {
    renderDialog(profileOfKind("managed"));

    fireEvent.click(screen.getByRole("button", { name: "Remove profile" }));

    expect(screen.getByText("Remove Work account?")).toBeTruthy();
    expect(
      screen.getByText(
        "Agents that ran on Work account will show it as removed. Running sessions on this profile must be stopped first.",
      ),
    ).toBeTruthy();
  });

  it("uses the approved mirror copy and environment fallback when offersSignIns is enabled", () => {
    fixture.offersSignIns = true;
    renderDialog({ ...profileOfKind("managed"), aliases: ["legacy-work"] });

    fireEvent.click(screen.getByRole("button", { name: "Remove profile" }));

    expect(
      screen.getByText(
        "Remove Work account from every list in this environment. Running work finishes first. You can add this account again later by signing in.",
      ),
    ).toBeTruthy();
  });

  it("removes the sole enabled record through its binding environment, then selects the remaining profile", async () => {
    fixture.offersSignIns = true;
    fixture.remainingProfiles = [
      { ...profileOfKind("managed"), profileId: "remaining-profile" },
    ];
    const messenger = installClient();
    renderDialog({ ...profileOfKind("managed"), aliases: [] });

    fireEvent.click(screen.getByRole("button", { name: "Remove profile" }));
    expect(screen.getByText("Remove Work account?")).toBeTruthy();
    fireEvent.click(screen.getByTestId("confirm-action"));

    await waitFor(() =>
      expect(fixture.auth.removeProfileRecord).toHaveBeenCalledTimes(1),
    );
    expect(fixture.auth.removeProfileRecord).toHaveBeenCalledWith(
      "bound-environment",
      "opencode",
      "profile-managed",
      null,
    );
    expect(fixture.localRemove).not.toHaveBeenCalled();
    expect(messenger.calls).toEqual([]);
    expect(fixture.bindingRefetch).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(fixture.selectedProfileIds).toEqual(["remaining-profile"]),
    );
    expect(fixture.openChanges).toEqual([false]);
  });

  it.each(["own_settings", "pending", "failed", "empty"] as const)(
    "fails closed with existing copy when the record binding is %s",
    async (bindingAnswer) => {
      fixture.offersSignIns = true;
      fixture.bindingAnswer = bindingAnswer;
      const messenger = installClient();
      renderDialog({ ...profileOfKind("managed"), aliases: [] });

      fireEvent.click(screen.getByRole("button", { name: "Remove profile" }));
      fireEvent.click(screen.getByTestId("confirm-action"));

      await waitFor(() =>
        expect(storedToastTitles()).toContain("Couldn't remove profile."),
      );
      expect(fixture.auth.removeProfileRecord).not.toHaveBeenCalled();
      expect(fixture.localRemove).not.toHaveBeenCalled();
      expect(fixture.bindingRefetch).not.toHaveBeenCalled();
      expect(messenger.calls).toEqual([]);
      expect(fixture.selectedProfileIds).toEqual([]);
    },
  );
});

function renderDialogWithOauthGate(
  canOauth: boolean,
  oauthUnavailableHint: string | null,
) {
  const profile = profileOfKind("managed");
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
          canOauth={canOauth}
          oauthUnavailableHint={oauthUnavailableHint}
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
 * `canOauth`/`oauthUnavailableHint` are the same host-gate pairing every other
 * sign-in control in this redesign takes: the switch is disabled while the
 * host would refuse the click, and the tooltip names why - the caller's own
 * hint when it has one, the dialog's generic sentence otherwise.
 */
describe("<ProfileEditDialog /> Switch account tooltip", () => {
  afterEach(() => {
    cleanup();
  });

  it("disables Switch account and shows the caller's hint when canOauth is false", () => {
    renderDialogWithOauthGate(
      false,
      "Claude Code is turned off. Turn it on to sign in or manage its profiles.",
    );
    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: "Switch account",
    });
    expect(button.disabled).toBe(true);
    expect(tooltipTextNear(button)).toBe(
      "Claude Code is turned off. Turn it on to sign in or manage its profiles.",
    );
  });

  it("falls back to the generic sentence when canOauth is false and no hint is given", () => {
    renderDialogWithOauthGate(false, null);
    const button = screen.getByRole("button", { name: "Switch account" });
    expect(tooltipTextNear(button)).toBe(
      "Switch account requires a local host with browser sign-in available.",
    );
  });

  it("enables Switch account with no tooltip when canOauth is true", () => {
    renderDialogWithOauthGate(true, "unused - canOauth true wins");
    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: "Switch account",
    });
    expect(button.disabled).toBe(false);
    expect(tooltipTextNear(button)).toBeNull();
  });
});
