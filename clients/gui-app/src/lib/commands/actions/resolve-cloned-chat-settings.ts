import {
  providerSupportsManagedProfiles,
  profileBindingsEqual,
  type ProfileBinding,
  resolveInheritedProfile,
} from "@traycer/protocol/host/provider-profile-inheritance";
import type { SpendScopeKey } from "@traycer/protocol/host/provider-credential-home-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type {
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { getNegotiatedHostMethodVersion } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { providerCliIdForHarness } from "@/lib/provider-ordering";
import {
  fallbackPermissionMode,
  autoModeOfferableHere,
  composerOffersPermissionMode,
  type PermissionMode,
} from "@/components/home/data/landing-options";

export interface ResolvedClonedChatSettings {
  readonly status: "ready";
  readonly settings: ChatRunSettings;
  /** Retained for callers that also clone harnesses without profiles. */
  readonly fallenBackToAmbient: boolean;
}

export interface ClonedChatProfileSelectionRequired {
  readonly status: "profile-selection-required";
  readonly providerId: ProviderId;
  readonly reason:
    | "matching-profile-disabled"
    | "not-on-destination"
    | "source-unidentified"
    | "explicit-profile-missing";
  readonly matchedProfileId: string | null;
  readonly targetProfiles: ReadonlyArray<ProviderProfile>;
}

export interface ClonedChatCatalogUnavailable {
  readonly status: "catalog-unavailable";
  readonly providerId: ProviderId;
}

export type ClonedChatProfileRecoveryRequired =
  | ClonedChatProfileSelectionRequired
  | ClonedChatCatalogUnavailable;

/**
 * The target's matching harness accepts neither the source's mode nor anything
 * its demotion chain offers, so there is no tuple to create with.
 *
 * A REFUSAL rather than a third clamp, and the reason is the one-way
 * rule: `auto` demotes to `auto_accept_edits` because dropping the judge is the
 * honest half-measure, while a walk to the safest SUPPORTED mode would land a
 * `["full_access"]` target on `supervised` - stricter than the chat the user is
 * cloning, which no one asked for. When the chain runs out, both remaining
 * options are wrong (an unsupported tuple the host rejects, or a mode the user
 * did not choose), so the clone stops and says so.
 *
 * Deliberately NOT part of `ClonedChatProfileRecoveryRequired`: nothing about a
 * profile is wrong here, and folding it in would hand this to the
 * profile-picker recovery UI, which has no action that could fix it.
 */
export interface ClonedChatPermissionModeUnsupported {
  readonly status: "permission-mode-unsupported";
  readonly harnessId: string;
  /** The source's mode first, then every rung of its demotion chain - what was
   *  tried, in order, so the message can name them. */
  readonly attemptedModes: ReadonlyArray<PermissionMode>;
}

export type ClonedChatSettingsResolution =
  | ResolvedClonedChatSettings
  | ClonedChatProfileRecoveryRequired
  | ClonedChatPermissionModeUnsupported;

// The wire array's ambient row keys itself by the literal "ambient" sentinel;
// every run/session-level profileId (chat settings included) uses `null` for
// the same concept. Mirrors `rate-limit-popover.tsx`'s identical mapping.
function normalizedProfileId(profile: ProviderProfile): string | null {
  return profile.kind === "ambient" ? null : profile.profileId;
}

/**
 * Resolve the clone's account on the target from its carried binding. Legacy
 * settings may read the source's live admitted identity; absence requires the
 * existing profile picker instead of substituting the target's ambient login.
 */
export async function resolveClonedChatSettings(input: {
  readonly sourceSettings: ChatRunSettings;
  readonly sourceClient: HostClient<HostRpcRegistry> | null;
  readonly targetClient: HostClient<HostRpcRegistry>;
  readonly explicitTargetProfileId: {
    readonly profileId: string | null;
  } | null;
}): Promise<ClonedChatSettingsResolution> {
  // Clamp the MODE against the target's catalog before anything else, so every
  // return below carries a tuple that host can actually accept.
  const clamped = await permissionModeForTarget(
    input.sourceSettings,
    input.targetClient,
  );
  // The refusal short-circuits everything below: there is no tuple to resolve a
  // profile for, and continuing would put an unsupported mode into the create.
  if ("status" in clamped) return clamped;
  const sourceSettings = clamped;
  const providerId = providerCliIdForHarness(sourceSettings.harnessId);
  if (providerId === null) {
    return {
      status: "ready",
      settings: { ...sourceSettings, profileId: null },
      fallenBackToAmbient: sourceSettings.profileId !== null,
    };
  }

  const targetProfiles = await readProviderProfiles(
    input.targetClient,
    providerId,
  );
  if (targetProfiles === null) {
    return { status: "catalog-unavailable", providerId };
  }
  let sourceKey =
    sourceSettings.profileBinding?.kind === "key"
      ? sourceSettings.profileBinding.key
      : null;
  if (
    providerSupportsManagedProfiles(providerId) &&
    sourceSettings.profileBinding === undefined &&
    input.explicitTargetProfileId === null &&
    input.sourceClient !== null
  ) {
    const sourceProfiles = await readProviderProfiles(
      input.sourceClient,
      providerId,
    );
    const identity = sourceProfiles?.find(
      (profile) => normalizedProfileId(profile) === sourceSettings.profileId,
    )?.credentialIdentity;
    if (identity?.kind === "spend-scoped") sourceKey = identity.spendScopeKey;
  }

  return resolveTargetProfile({
    sourceSettings,
    providerId,
    targetProfiles,
    sourceKey,
    explicitTargetProfileId: input.explicitTargetProfileId,
  });
}

/**
 * The source chat's settings with `permissionMode` resolved against the TARGET
 * host's catalog.
 *
 * The clone hands its tuple straight to the target's `epic.createChat`, so a
 * mode that host cannot spell fails the create outright - and `auto` is exactly
 * such a mode on any host below the line that introduced it. The composer and
 * session-import paths already demote this case; the clone carried it verbatim,
 * which is the one path where the whole operation is lost rather than degraded.
 *
 * **Demotes only on POSITIVE evidence**, and that asymmetry is deliberate.
 * Proof is one row answering: the TARGET row named by `settings.harnessId`,
 * present in the catalog and not listing `auto`. Two other shapes are not
 * proof and leave the mode alone - a catalog read that FAILS (guessing from a
 * transient blip would silently change a durable setting), and a catalog with
 * no row for that harness at all (which says the target lacks the harness, a
 * different and honest failure the create will surface itself). This
 * function's neighbour takes the same line one field over - a failed
 * `providers.list` becomes the explicit, retryable `catalog-unavailable`
 * rather than an assumed ambient profile.
 *
 * `fallbackPermissionMode` is the shared one-way demotion (`auto` ->
 * `auto_accept_edits`): dropping the judge is the honest half-measure, where a
 * walk to the safest supported mode would land on `supervised` and make a
 * cloned chat stricter than the one it came from.
 */
async function permissionModeForTarget(
  settings: ChatRunSettings,
  targetClient: HostClient<HostRpcRegistry>,
): Promise<ChatRunSettings | ClonedChatPermissionModeUnsupported> {
  if (settings.permissionMode !== "auto") return settings;
  const harnesses = await targetClient
    .request("agent.gui.listHarnesses", {})
    .then(
      (response) => response.harnesses,
      () => null,
    );
  if (harnesses === null) return settings;
  // The row this chat will actually RUN on, not the catalog as a whole. A
  // catalog-wide `some()` preserves `auto` whenever ANY target harness offers
  // it, which is the wrong question on a mixed target: the create carries one
  // `harnessId`, and `assertPermissionModeSupported` on the host judges the
  // tuple against that harness alone. A chat on a harness without `auto`
  // cloned onto a host where some other harness has it would still be rejected.
  const targetRow = harnesses.find(
    (harness) => harness.id === settings.harnessId,
  );
  // No row is not positive evidence about the MODE - it says the target has no
  // such harness at all, which fails the create for a different and honest
  // reason. Clamping here would quietly rewrite the mode on the way to an
  // error about something else.
  if (targetRow === undefined) return settings;
  // Through the shared predicate, not a bare `.includes`, and paired with the
  // TARGET host's own line. An EMPTY `supportedPermissionModes` is a harness
  // that answered and constrained nothing - the host's own assert
  // short-circuits on it - so a raw `includes` read it as "no auto here" and
  // silently rewrote the user's mode on a target that would have accepted it.
  //
  // But an unconstrained row on a PRE-`auto` target says nothing about the
  // wire: that host serves unconstrained rows like any other and still cannot
  // carry the enum. The catalog request above has already completed on this
  // client, so the target's negotiated manifest is recorded by the time we get
  // here - a `null` reads as "cannot spell it", the safe direction, and demotes
  // exactly as an unsupported row does.
  const targetHostId = targetClient.getActiveHostId() ?? null;
  // Through the same two-proof predicate every composer uses, with the chat
  // half explicitly `null`: a clone CREATES a chat on the target, so no
  // `chat.subscribe` line has been negotiated for it and the catalog line is
  // genuinely all this path can know. Routed through `autoModeOfferableHere`
  // rather than calling `catalogLineKnowsAutoMode` directly so the second
  // proof is visibly ANSWERED here rather than silently absent - if a future
  // clone path gains a live session, this is the argument that changes.
  const targetKnowsAutoMode = autoModeOfferableHere(
    targetHostId === null
      ? null
      : getNegotiatedHostMethodVersion(targetHostId, "agent.gui.listHarnesses"),
    null,
  );
  // The source's mode first, then each rung of its demotion chain, each one
  // checked against the target row. The chain was previously applied ONE step
  // and unchecked, which is the defect: `auto` became `auto_accept_edits` on a
  // `["full_access"]` row and went to `epic.createChat` as a tuple that host
  // refuses. A rung that the target does not accept is not a landing place.
  const attemptedModes = [
    settings.permissionMode,
    ...demotionChain(settings.permissionMode),
  ];
  for (const candidate of attemptedModes) {
    if (
      composerOffersPermissionMode(
        targetRow.supportedPermissionModes,
        candidate,
        targetKnowsAutoMode,
      )
    ) {
      return candidate === settings.permissionMode
        ? settings
        : { ...settings, permissionMode: candidate };
    }
  }
  return {
    status: "permission-mode-unsupported",
    harnessId: settings.harnessId,
    attemptedModes,
  };
}

/**
 * Every mode `value` demotes THROUGH, in order, excluding `value` itself.
 *
 * Built by applying {@link fallbackPermissionMode} to a fixed point rather than
 * once: that helper answers itself when a mode declares no fallback, so the
 * walk terminates on its own and a chain that grows a third rung later is
 * followed here with no edit. Today `auto` yields `["auto_accept_edits"]` and
 * every other mode yields `[]`.
 */
function demotionChain(value: PermissionMode): ReadonlyArray<PermissionMode> {
  const chain: PermissionMode[] = [];
  let current = value;
  for (;;) {
    const next = fallbackPermissionMode(current);
    if (next === current) return chain;
    chain.push(next);
    current = next;
  }
}

async function readProviderProfiles(
  client: HostClient<HostRpcRegistry>,
  providerId: ProviderId,
): Promise<ReadonlyArray<ProviderProfile> | null> {
  return client.request("providers.list", { native: null }).then(
    (response) =>
      response.providers.find((provider) => provider.providerId === providerId)
        ?.profiles ?? [],
    () => null,
  );
}

function resolveTargetProfile(input: {
  readonly sourceSettings: ChatRunSettings;
  readonly providerId: ProviderId;
  readonly targetProfiles: ReadonlyArray<ProviderProfile>;
  readonly sourceKey: SpendScopeKey | null;
  readonly explicitTargetProfileId: {
    readonly profileId: string | null;
  } | null;
}): ClonedChatSettingsResolution {
  const { sourceSettings, providerId, targetProfiles } = input;
  if (input.explicitTargetProfileId !== null) {
    const explicitTargetProfileId = input.explicitTargetProfileId.profileId;
    const explicitProfile = targetProfiles.find(
      (profile) => normalizedProfileId(profile) === explicitTargetProfileId,
    );
    if (explicitProfile?.enabled === true) {
      return {
        status: "ready",
        settings: settingsForProfile(
          sourceSettings,
          normalizedProfileId(explicitProfile),
          explicitProfile.credentialIdentity?.kind === "spend-scoped"
            ? {
                kind: "key",
                key: explicitProfile.credentialIdentity.spendScopeKey,
              }
            : undefined,
        ),
        fallenBackToAmbient: false,
      };
    }
    return profileSelectionRequired({
      providerId,
      reason:
        explicitProfile === undefined
          ? "explicit-profile-missing"
          : "matching-profile-disabled",
      matchedProfileId: explicitTargetProfileId,
      targetProfiles,
    });
  }

  if (!providerSupportsManagedProfiles(providerId)) {
    const terminal = targetProfiles.find(
      (profile) => profile.kind === "ambient",
    );
    if (terminal?.enabled === true) {
      return {
        status: "ready",
        settings: settingsForProfile(sourceSettings, null, undefined),
        fallenBackToAmbient: sourceSettings.profileId !== null,
      };
    }
    return profileSelectionRequired({
      providerId,
      reason: "matching-profile-disabled",
      matchedProfileId: null,
      targetProfiles,
    });
  }

  const resolution = resolveInheritedProfile(
    input.sourceKey,
    targetProfiles.map((profile) => ({
      profileId: normalizedProfileId(profile),
      spendScopeKey:
        profile.credentialIdentity?.kind === "spend-scoped"
          ? profile.credentialIdentity.spendScopeKey
          : null,
    })),
  );
  if (resolution.kind !== "match") {
    return profileSelectionRequired({
      providerId,
      reason: resolution.kind,
      matchedProfileId: null,
      targetProfiles,
    });
  }
  const matchingProfile = targetProfiles.find(
    (profile) => normalizedProfileId(profile) === resolution.profileId,
  );
  if (matchingProfile?.enabled !== true) {
    return profileSelectionRequired({
      providerId,
      reason: "matching-profile-disabled",
      matchedProfileId: resolution.profileId,
      targetProfiles,
    });
  }
  return {
    status: "ready",
    settings: settingsForProfile(
      sourceSettings,
      resolution.profileId,
      input.sourceKey === null
        ? { kind: "source-unidentified" }
        : { kind: "key", key: input.sourceKey },
    ),
    fallenBackToAmbient: false,
  };
}

function profileSelectionRequired(input: {
  readonly providerId: ProviderId;
  readonly reason: ClonedChatProfileSelectionRequired["reason"];
  readonly matchedProfileId: string | null;
  readonly targetProfiles: ReadonlyArray<ProviderProfile>;
}): ClonedChatProfileSelectionRequired {
  return { status: "profile-selection-required", ...input };
}

/** Preserve the tuple's identity when a selection changes none of its fields. */
function settingsForProfile(
  settings: ChatRunSettings,
  profileId: string | null,
  profileBinding: ProfileBinding | undefined,
): ChatRunSettings {
  return settings.profileId === profileId &&
    profileBindingsEqual(settings.profileBinding, profileBinding)
    ? settings
    : { ...settings, profileId, profileBinding };
}
