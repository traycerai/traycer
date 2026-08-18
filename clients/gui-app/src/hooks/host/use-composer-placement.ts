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
  /**
   * READ scope: the client this composer's queries (catalog, mentions,
   * workspace resolution, usage) run on. Mutable while following, which is
   * correct for reads - they should re-point when derivation moves.
   */
  readonly target: LandingPlacementTarget;
  /**
   * SUBMIT scope: identical except its client is FROZEN to `resolvedHostId`
   * for the duration of a submit. Pass this - never `target` - to anything
   * that creates. See the frozen-requester note below.
   */
  readonly submitTarget: LandingPlacementTarget;
  /** Names an arbitrary host for notice copy, resolved late. */
  readonly hostLabelFor: (hostId: string | null) => string;
  /**
   * Whether a move of the EFFECTIVE host re-points this composer. True only
   * when nothing else answered: no override, no pin in force, and (for a
   * placement that carries a default tier) no default in force. A composer
   * resting on its pin or its default is not moved by a derivation change and
   * must not narrate one (the G4 "re-pointed" notice).
   */
  readonly followsEffective: boolean;
}

/**
 * One resolution of "where would this composer place new work" (redesign
 * P1.2), so the chip, the RPCs the composer makes, its creates, and its
 * submit-time refusal can never be derived independently and disagree.
 *
 * `overrideHostId` is a caller-supplied host that outranks the pin: the
 * new-conversation modal's row-scoped request names one, and the picker goes
 * inert for it (§55). `null` means "this surface owns its placement": the
 * landing composer resolves its WINDOW-keyed pin ?? effective (this hook);
 * the in-Epic new-conversation modal resolves its per-EPIC pin ?? the Epic
 * session's host ?? effective (`useEpicConversationPlacement` below).
 *
 * **Two clients, deliberately.**
 *
 * `target.client` addresses the tier that answered: a composer that is
 * unpinned - or pinned to a host that has died, which resolves the same way -
 * reads through the app-wide bound client and re-points when derivation moves;
 * one whose pin or default tier answered reads that host.
 * That is right for queries and wrong for creates: the app-wide client rebinds IN
 * PLACE, so a multi-RPC submit chain (`epic.create` → `agent.tui.prepareLaunch`
 * → `epic.createTuiAgent`) that awaits between steps can have later steps land
 * on host B against an epic created on host A. Nothing in the chain would
 * notice, because the client object never changed identity.
 *
 * `submitTarget.client` therefore resolves the RESOLVED host id, not the pin -
 * `useHostClientForHostId(resolvedHostId)` returns a pinned requester whose
 * `getActiveHostId()` is frozen to that id for life, so every RPC in a chain
 * provably targets the host the placement resolved, even while following. When
 * that host cannot be addressed at all the requester is `null`, which
 * `resolveLandingPlacement` refuses on - an honest refusal instead of a
 * silently re-pointed create.
 */
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
  /**
   * The Epic session's host - the default tier. `null` (no session yet)
   * drops the tier and the placement resolves as the landing composer does.
   */
  readonly sessionHostId: string | null;
}

/**
 * The in-Epic new-conversation modal's placement (redesign follow-up to
 * P1.2 §2, user ruling 2026-08-18): the SAME chip and pin pattern as the
 * landing composer, resolved per EPIC with a memory tier -
 *
 *     override ?? pin(epic) ?? Epic session's host ?? effective
 *
 * where `pin(epic)` is that Epic's "last created chat's host": the picker
 * writes it, and every successful create in the modal RECORDS it
 * (`recordPlacement`), the way the model picker's last-used memory is
 * written by use as well as by a pick. So the chip opens on the host the
 * last agent in this Epic was created on, or - before any - on the host the
 * Epic is being served from; never on wherever the window's landing chip
 * last pointed, which is not a fact about this Epic. The pin's death rules
 * apply to every tier (`useSurfaceHostPinWithDefault`).
 *
 * The modal used to share the landing composer's WINDOW-keyed pin, on the
 * reasoning that the two must agree while both are visible; they never are
 * (the modal always has an Epic behind it, the landing composer never does),
 * so nothing was kept in agreement and the in-Epic default was the wrong
 * question's answer.
 */
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

/**
 * The shared resolution: one pin (however keyed and defaulted), one override,
 * one read client and one FROZEN submit client, one refusal. `pinFollowsEffective`
 * is the pin's own account of whether `effective` answered it - the caller
 * knows the pin's tiers; this function does not re-derive them.
 */
function useComposerPlacementForPin(
  pin: SurfaceHostPin,
  overrideHostId: string | null,
  pinFollowsEffective: boolean,
): ComposerPlacement {
  const resolvedHostId = overrideHostId ?? pin.resolvedHostId;
  // The read client addresses the host the chip is SHOWING: the resolved host
  // when a pin or the caller's default answered, and the following (ambient)
  // client - which IS the effective host - only when `effective` answered, so
  // that reads keep following a derivation move exactly as the chip does. A
  // deposed pin has already re-resolved to `effective`, so it lands here too;
  // reading `selection` would point every composer query at the dead machine.
  //
  // This used to be keyed on `pin.honoredSelection`, which is null on the
  // DEFAULT tier as well as on the effective one. That is invisible for the
  // landing composer (two tiers - no pin means effective) and wrong for the
  // in-Epic modal (three tiers): with the Epic served from A and the app-wide
  // host on B, the chip, the staging key and the create all named A while
  // every read - the folder picker, the harness/model catalog, the workspace
  // seed - went to B, and a chat landed on A carrying folders that exist only
  // on B.
  const readClient = useHostClientForHostId(
    overrideHostId ?? (pinFollowsEffective ? null : pin.resolvedHostId),
  );
  const submitClient = useHostClientForHostId(resolvedHostId);
  // OVERRIDE ONLY. A pin that dies has already re-resolved to `effective` by
  // the time submit runs - `pin.resolvedHostId` is the live host, so there is
  // nothing here to refuse. A caller-NAMED host does not re-resolve (naming it
  // is the request), so it is the one thing left that can be dead at submit.
  //
  // Derived from the lease, on the same rule the pin resolver uses, so the two
  // cannot disagree about what "dead" means.
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
