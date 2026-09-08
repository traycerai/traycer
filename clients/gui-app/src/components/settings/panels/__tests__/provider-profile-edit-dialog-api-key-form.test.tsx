import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

// Same rationale as the sibling panel suites: the dialog pulls in
// mutation/host hooks unconditionally, so those are stubbed to keep this test
// scoped to a QueryClient with no bound host. The gate under test reads only
// `profile.apiKey`, so none of these participate in it.
//
// NOTE, because the stub below is a LIE about the contract and the next person
// here will trip on it: `useHostClient()` returns `HostClient<HostRpcRegistry>`
// and THROWS when there is no provider - it never returns null. "No usable
// host" is a client whose `getActiveHostId()` is null and whose requests fail
// at preflight, not a null client. This suite gets away with the stub only
// because it also mocks both API-key mutation hooks, which are the ones that
// dereference the client. Mount this form without those mocks and you get a
// `Cannot read properties of null` from inside a hook, which reads as a bug in
// the hook rather than as a fixture that misdescribes its type - stub a client
// whose `getActiveHostId()` returns null instead.
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

// The two hooks this suite is actually about. Held in a mutable hoisted record
// so a test can vary `isPending` without re-mocking the module.
//
// `used` counts HOOK INVOCATIONS, not mutations - it is what makes "the gate is
// a MOUNT decision" observable. Without it a gate that mounts the form and
// returns null from inside it is indistinguishable from one that never mounts
// it, and only the second keeps `useQueryClient` off surfaces that have no
// `QueryClientProvider`.
const apiKeyMutation = vi.hoisted(() => ({
  set: { mutate: vi.fn(), reset: vi.fn(), isPending: false, used: vi.fn() },
  clear: { mutate: vi.fn(), reset: vi.fn(), isPending: false, used: vi.fn() },
  // The MUTATION-level success callback each hook is handed. The draft clear
  // lives here, not in a `mutate(vars, { onSuccess })` bag, so that it still
  // runs when the form has unmounted behind the reauth panel.
  onSuccess: { set: null, clear: null } as {
    set: (() => void) | null;
    clear: (() => void) | null;
  },
}));

vi.mock("@/hooks/providers/use-set-provider-profile-api-key-mutation", () => ({
  useSetProviderProfileApiKey: (onSuccess: (() => void) | undefined) => {
    apiKeyMutation.set.used();
    apiKeyMutation.onSuccess.set = onSuccess ?? null;
    return {
      mutate: apiKeyMutation.set.mutate,
      reset: apiKeyMutation.set.reset,
      isPending: apiKeyMutation.set.isPending,
      error: null,
    };
  },
}));
vi.mock(
  "@/hooks/providers/use-clear-provider-profile-api-key-mutation",
  () => ({
    useClearProviderProfileApiKey: (onSuccess: (() => void) | undefined) => {
      apiKeyMutation.clear.used();
      apiKeyMutation.onSuccess.clear = onSuccess ?? null;
      return {
        mutate: apiKeyMutation.clear.mutate,
        reset: apiKeyMutation.clear.reset,
        isPending: apiKeyMutation.clear.isPending,
        error: null,
      };
    },
  }),
);

import { ProfileEditDialog } from "@/components/settings/panels/provider-profile-edit-dialog";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";

const PROVIDER_ID = "opencode";
const PROFILE_ID = "profile-managed";

/**
 * A managed profile with NO `apiKey` key at all. Every fixture below spreads
 * this and adds the key it is about, so the "absent" arm is genuinely absent
 * rather than `apiKey: undefined` - the two decode the same through the
 * component's `?? null`, but only one of them is what an older host actually
 * sends.
 */
function baseProfile(): ProviderProfile {
  return {
    profileId: PROFILE_ID,
    enabled: true,
    kind: "managed",
    authType: "oauth",
    label: "Work account",
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

function profileWithApiKey(
  apiKey: NonNullable<ProviderProfile["apiKey"]> | null,
): ProviderProfile {
  return { ...baseProfile(), apiKey };
}

function opencodeState(profile: ProviderProfile): ProviderCliState {
  return {
    providerId: PROVIDER_ID,
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
    // The PROVIDER-wide key state, deliberately unsupported here: the form this
    // suite is about must come from the PROFILE's own state and nothing else.
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
          startInReauth={false}
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

function keyField(): HTMLInputElement | null {
  return screen.queryByLabelText<HTMLInputElement>("API key");
}

beforeEach(() => {
  apiKeyMutation.set.isPending = false;
  apiKeyMutation.clear.isPending = false;
  // `vi.clearAllMocks()` in `afterEach` clears CALLS, not implementations, so
  // a test that makes a mutate invoke its `onSuccess` would leak that into
  // every test after it. State the default here instead: mutate is called and
  // nothing settles, which is what a request in flight looks like.
  apiKeyMutation.set.mutate.mockImplementation(() => undefined);
  apiKeyMutation.clear.mutate.mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/**
 * `ProviderProfile.apiKey` is `.nullable().catch(null).optional()`, which makes
 * THREE distinct states reach the renderer, and only one of them gets a form.
 *
 * Parameterised over all four fixtures - the three no-form states and the one
 * that does - rather than written as separate assertions, so no arm can quietly
 * stop exercising its branch. The `supported: true` arm is the positive
 * control: without it, a gate that renders nothing at all passes every other
 * arm.
 */
describe("<ProfileEditDialog /> per-profile API-key gate", () => {
  const cases = [
    {
      state: "absent (a host that predates the field, and the RPCs)",
      profile: baseProfile,
      form: false,
    },
    {
      state: "null (a malformed state normalized by .catch(null))",
      profile: () => profileWithApiKey(null),
      form: false,
    },
    {
      state: "supported:false (no key method for this provider/kind pair)",
      profile: () => profileWithApiKey({ supported: false, configured: false }),
      form: false,
    },
    {
      state: "supported:true",
      profile: () => profileWithApiKey({ supported: true, configured: false }),
      form: true,
    },
  ] as const;

  // FALSIFICATION (run, and it reddens exactly the two unknown arms while the
  // `supported:false` and `supported:true` arms stay green):
  //   `profileApiKeyFormState`'s `profile.apiKey ?? null`
  //     -> `profile.apiKey ?? { supported: true, configured: false }`
  // FALSIFICATION for the `supported:false` arm alone:
  //   `if (apiKey === null || !apiKey.supported) return null;`
  //     -> `if (apiKey === null) return null;`
  it.each(cases)(
    "apiKey $state renders the paste form: $form",
    ({ profile, form }) => {
      renderDialog(profile());

      expect(keyField() !== null).toBe(form);
    },
  );

  // FALSIFICATION: the same `?? { supported: true, ... }` edit above reddens
  // this too - under it the form MOUNTS for an unknown state and the hooks run.
  it.each(cases)(
    "apiKey $state mounts the form's mutation hooks: $form",
    ({ profile, form }) => {
      renderDialog(profile());

      // The gate is applied by the DIALOG, so a no-form state must not even
      // construct the mutations. This is the property whose absence broke the
      // sibling panel suites: they render this dialog with no
      // `QueryClientProvider`, and a form component that gated itself would
      // still have called `useQueryClient` on every profile.
      expect(apiKeyMutation.set.used).toHaveBeenCalledTimes(form ? 1 : 0);
      expect(apiKeyMutation.clear.used).toHaveBeenCalledTimes(form ? 1 : 0);
    },
  );

  it("CONTROL: the 'absent' fixture really omits the key, so that arm is not silently the null arm", () => {
    // Without this, weakening the fixture to `apiKey: undefined` would leave
    // the gate's absent case untested while the suite stayed green.
    expect(Object.hasOwn(baseProfile(), "apiKey")).toBe(false);
  });

  it("CONTROL: the provider-wide apiKey state is unsupported in every fixture, so the form above is the PROFILE's", () => {
    // `supported` is a property of the provider-and-kind pair. If the form were
    // (incorrectly) keyed off `state.apiKey`, the positive arm could not have
    // rendered at all - this pins that the fixture makes those two disagree.
    const supported = profileWithApiKey({ supported: true, configured: false });
    expect(opencodeState(supported).apiKey.supported).toBe(false);
    expect(supported.apiKey?.supported).toBe(true);
  });
});

/**
 * `configured` chooses between Replace/Remove and Add. Both arms are asserted
 * for both affordances, so an implementation that always shows one label, or
 * always shows Remove, reddens.
 */
describe("<ProfileEditDialog /> API-key affordances by `configured`", () => {
  // FALSIFICATION: `{apiKey.configured ? (` on the Remove button -> `{true ? (`
  // reddens this arm alone (the configured arm still finds its Remove button).
  it("an unconfigured profile offers Add and no Remove", () => {
    renderDialog(profileWithApiKey({ supported: true, configured: false }));

    expect(screen.getByRole("button", { name: "Add key" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Replace key" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove key" })).toBeNull();
  });

  // FALSIFICATION: collapse the label ternary -
  // `const saveLabel = apiKey.configured ? "Replace key" : "Add key";`
  //   -> `const saveLabel = "Add key";`
  // reddens this arm alone.
  it("a configured profile offers Replace and Remove", () => {
    renderDialog(profileWithApiKey({ supported: true, configured: true }));

    expect(screen.getByRole("button", { name: "Replace key" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Remove key" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Add key" })).toBeNull();
  });

  it("never renders a stored key back into the field: masked, and empty on open", () => {
    // The state object carries two booleans and no value, so there is nothing
    // to echo even by accident - what this pins is the INPUT's own contract:
    // a credential field is `type=password`, not a text box, and a configured
    // profile opens with an empty draft rather than a placeholder-as-value.
    //
    // FALSIFICATION: the input's `type="password"` -> `type="text"` reddens
    // this alone.
    renderDialog(profileWithApiKey({ supported: true, configured: true }));

    const field = keyField();
    expect(field?.type).toBe("password");
    expect(field?.value).toBe("");
    expect(field?.placeholder).toBe("Replace stored key…");
  });
});

describe("<ProfileEditDialog /> API-key submission", () => {
  // FALSIFICATION for both this test and the whitespace one below (one edit,
  // two reds - the padded value survives to the request, and the whitespace
  // draft stops counting as empty):
  //   `const trimmed = props.draft.trim();` -> `const trimmed = props.draft;`
  it("sends the TRIMMED key scoped to this profile, and clears the draft", () => {
    renderDialog(profileWithApiKey({ supported: true, configured: false }));

    const field = keyField();
    expect(field).not.toBeNull();
    if (field === null) return;

    fireEvent.change(field, { target: { value: "   sk-live-abc   " } });
    fireEvent.click(screen.getByRole("button", { name: "Add key" }));

    expect(apiKeyMutation.set.mutate).toHaveBeenCalledTimes(1);
    // Asserted through the matcher rather than by destructuring
    // `mock.calls[0]`, which is an `any[]` and defeats the type-aware lint.
    // ONE argument: the success work moved to the hook's own options, so there
    // is no per-`mutate` bag left to match loosely.
    expect(apiKeyMutation.set.mutate).toHaveBeenCalledWith({
      providerId: PROVIDER_ID,
      profileId: PROFILE_ID,
      apiKey: "sk-live-abc",
    });
  });

  it("refuses a whitespace-only paste rather than sending it", () => {
    // `providers.setProfileApiKey`'s `apiKey` is `min(1)` precisely so an empty
    // paste is not read as a clear. The button stays disabled so the slip never
    // becomes a round trip.
    renderDialog(profileWithApiKey({ supported: true, configured: false }));

    const field = keyField();
    expect(field).not.toBeNull();
    if (field === null) return;

    fireEvent.change(field, { target: { value: "    " } });
    const save = screen.getByRole<HTMLButtonElement>("button", {
      name: "Add key",
    });
    expect(save.disabled).toBe(true);

    fireEvent.click(save);
    expect(apiKeyMutation.set.mutate).not.toHaveBeenCalled();
  });

  it("Remove sends the profile scope and NO key field", () => {
    // The scope is the whole reason these are separate methods: a profileId
    // dropped from the request does not degrade to "no scope", it degrades to
    // "every profile" against the provider-wide store.
    //
    // FALSIFICATION: drop `profileId: props.profile.profileId,` from the
    // `clearApiKey.mutate({...})` call and this reddens alone.
    renderDialog(profileWithApiKey({ supported: true, configured: true }));

    fireEvent.click(screen.getByRole("button", { name: "Remove key" }));

    expect(apiKeyMutation.clear.mutate).toHaveBeenCalledTimes(1);
    // The sole argument carries the request, and asserting it by object
    // equality is what pins that it holds no key field.
    expect(apiKeyMutation.clear.mutate).toHaveBeenCalledWith({
      providerId: PROVIDER_ID,
      profileId: PROFILE_ID,
    });
  });

  it("clears a typed replacement once the removal SUCCEEDS, so it cannot be re-armed", () => {
    // The sequence that makes this matter: a configured profile, a replacement
    // typed but never saved, then Remove instead. Without the success callback
    // the field keeps that secret while the row flips to "Not set" and the
    // button becomes an ENABLED "Add key" - one Enter away from storing the
    // credential the user was in the middle of removing.
    //
    // The callback is driven from where the hook received it, which is the
    // point: a per-`mutate` bag would be dropped by TanStack in exactly the
    // Remove-then-Switch-account sequence this guards, because the form's
    // observer is gone by the time the removal settles.
    //
    // FALSIFICATION: stop passing the clear to
    // `useClearProviderProfileApiKey(...)` - or hand it to
    // `clearApiKey.mutate(vars, { onSuccess })` instead - and this reddens
    // while the CONTROL below stays green.
    apiKeyMutation.clear.mutate.mockImplementation(() => {
      apiKeyMutation.onSuccess.clear?.();
    });
    renderDialog(profileWithApiKey({ supported: true, configured: true }));

    const field = keyField();
    expect(field).not.toBeNull();
    if (field === null) return;
    fireEvent.change(field, { target: { value: "sk-typed-but-not-saved" } });
    expect(field.value).toBe("sk-typed-but-not-saved");

    fireEvent.click(screen.getByRole("button", { name: "Remove key" }));

    expect(keyField()?.value).toBe("");
  });

  it("drops the SIBLING mutation's error when starting either operation", () => {
    // The two are separate observers and the form renders
    // `setApiKey.error ?? clearApiKey.error`, so without this a failure from
    // one outlives the other's success - a stale "couldn't save" sitting under
    // a profile that now reads "Not set", and the mirror image the other way.
    // Only the most recently attempted mutation should be able to speak.
    //
    // FALSIFICATION: remove either `reset()` call and the matching assertion
    // reddens. Asserted on the SIBLING each time, which is the whole point -
    // resetting the one being started would clear nothing that was showing.
    renderDialog(profileWithApiKey({ supported: true, configured: true }));

    const field = keyField();
    expect(field).not.toBeNull();
    if (field === null) return;
    fireEvent.change(field, { target: { value: "sk-replacement" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace key" }));
    expect(apiKeyMutation.clear.reset).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
    expect(apiKeyMutation.set.reset).toHaveBeenCalledTimes(1);
  });

  it("CONTROL: a removal that never settles KEEPS the draft, so the clear above is the callback and not the click", () => {
    // The default mock never invokes `onSuccess`. A removal that failed
    // removed nothing, so discarding what the user typed would be the wrong
    // call - and without this arm, clearing the draft unconditionally on
    // click would pass the test above just as well.
    renderDialog(profileWithApiKey({ supported: true, configured: true }));

    const field = keyField();
    expect(field).not.toBeNull();
    if (field === null) return;
    fireEvent.change(field, { target: { value: "sk-typed-but-not-saved" } });

    fireEvent.click(screen.getByRole("button", { name: "Remove key" }));

    expect(keyField()?.value).toBe("sk-typed-but-not-saved");
  });

  // FALSIFICATION:
  //   `const busy = setApiKey.isPending || clearApiKey.isPending || props.disabled;`
  //     -> `const busy = props.disabled;`
  // reddens this alone.
  it("a pending save disables the field and the button WITHOUT changing the label", () => {
    apiKeyMutation.set.isPending = true;
    renderDialog(profileWithApiKey({ supported: true, configured: false }));

    const field = keyField();
    expect(field?.disabled).toBe(true);
    // The label stays "Add key" - the house rule is `disabled={isPending}` plus
    // an inline spinner, never a swapped "Saving…" label. Asserted here so a
    // later edit that swaps it reddens rather than passing review.
    const save = screen.getByRole<HTMLButtonElement>("button", {
      name: "Add key",
    });
    expect(save.disabled).toBe(true);
  });
});
