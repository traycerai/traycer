import { useCallback, useMemo } from "react";
import { useComposerSurfaceHostPin } from "@/hooks/host/use-composer-surface-host-pin";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useHostLeases } from "@/hooks/host/use-host-lease";
import { useSelectionAuthorityAttached } from "@/hooks/host/use-selection-authority-attached";
import {
  useSurfaceHostPinWithDefault,
  type SurfaceHostPin,
} from "@/hooks/host/use-surface-host-pin";
import {
  isSurfacePinDeposed,
  newConversationSurfaceKey,
} from "@/stores/host/surface-host-selection-store";
import {
  composerHostLabel,
  type LandingPlacementTarget,
} from "@/lib/composer/landing-placement";

export interface ComposerPlacement {
  /** The window's composer pin. Write it from the picker; read below for use. */
  readonly pin: SurfaceHostPin;
  /** READ scope: the client this composer's queries (catalog, mentions, workspace resolution, usage) run on. */
  readonly target: LandingPlacementTarget;
  /** Pass this - never `target` - to anything that creates. */
  readonly submitTarget: LandingPlacementTarget;
  /** Names an arbitrary host for notice copy, resolved late. */
  readonly hostLabelFor: (hostId: string | null) => string;
  /** A composer resting on its pin or its default is not moved by a derivation change and must not narrate one (the G4 "re-pointed" notice).
   * True only when nothing else answered: no override, no pin in force, and (for a placement that carries a default tier) no default in force. */
  readonly followsEffective: boolean;
}

/** One placement resolution for chip, RPCs, creates, and submit refusal. */
export function useComposerPlacement(
  overrideHostId: string | null,
): ComposerPlacement {
  const pin = useComposerSurfaceHostPin();
  return useComposerPlacementForPin(
    pin,
    overrideHostId,
    pin.honoredSelection === null,
  );
}

export interface EpicConversationPlacementInput {
  readonly epicId: string;
  /** A caller-NAMED host (the row-scoped request); the picker goes inert. */
  readonly overrideHostId: string | null;
  readonly sessionHostId: string | null;
}

/** override ?? pin(epic) ?? session host ?? effective. Never the landing window pin. */
export function useEpicConversationPlacement(
  input: EpicConversationPlacementInput,
): ComposerPlacement {
  const pin = useSurfaceHostPinWithDefault(
    newConversationSurfaceKey(input.epicId),
    input.sessionHostId,
  );
  return useComposerPlacementForPin(
    pin,
    input.overrideHostId,
    pin.resolvedFrom === "effective",
  );
}

/** `pinFollowsEffective` is the pin's own account of whether `effective` answered it - the caller knows the pin's tiers; this function does not re-derive them. */
function useComposerPlacementForPin(
  pin: SurfaceHostPin,
  overrideHostId: string | null,
  pinFollowsEffective: boolean,
): ComposerPlacement {
  const resolvedHostId = overrideHostId ?? pin.resolvedHostId;
  // Read client is the host the chip shows (resolved pin/default, or the following client on `effective`). Reading `selection` would point composer queries at a deposed machine.
  const readClient = useHostClientForHostId(
    overrideHostId ?? (pinFollowsEffective ? null : pin.resolvedHostId),
  );
  const submitClient = useHostClientForHostId(resolvedHostId);
  // A pin that dies has already re-resolved to `effective` by the time submit runs - `pin.resolvedHostId` is the live host, so there is nothing here to refuse.
  const leases = useHostLeases();
  const authorityAttached = useSelectionAuthorityAttached();
  const namedHostDead =
    overrideHostId !== null &&
    isSurfacePinDeposed(overrideHostId, { authorityAttached, leases });
  const directory = useHostDirectoryList();
  const entries = directory.data ?? null;
  const hostLabelFor = useCallback(
    (hostId: string | null) => composerHostLabel(entries, hostId),
    [entries],
  );
  const isPinned = overrideHostId !== null || pin.isPinned;
  const target = useMemo<LandingPlacementTarget>(
    () => ({
      resolvedHostId,
      client: readClient,
      hostLabel: composerHostLabel(entries, resolvedHostId),
      isPinned,
      namedHostDead,
    }),
    [entries, isPinned, namedHostDead, readClient, resolvedHostId],
  );
  const submitTarget = useMemo<LandingPlacementTarget>(
    () => ({ ...target, client: submitClient }),
    [submitClient, target],
  );
  const followsEffective = overrideHostId === null && pinFollowsEffective;
  return { pin, target, submitTarget, hostLabelFor, followsEffective };
}
