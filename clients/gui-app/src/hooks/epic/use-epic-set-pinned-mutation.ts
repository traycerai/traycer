import { useMemo } from "react";
import {
  useMutationState,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useHostMutation } from "@/hooks/host/use-host-query";
import {
  useHostBinding,
  useHostClient,
  type HostRpcRegistry,
} from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { useCallback } from "react";
import { toastFromHostError } from "@/lib/host-error-toast";
import {
  cloudEpicTasksQueryKeyMatchesScope,
  epicPinReadingQueryKeyMatchesScope,
  setEpicPinnedInCloudTaskCaches,
} from "@/lib/cloud-epic-tasks-query/cache";
import { epicMutationKeys } from "@/lib/query-keys";
import {
  resetCloudEpicTasksPagesForScope,
  setCloudEpicTasksPagePinned,
} from "@/stores/epics/cloud-epic-tasks-pages-store";
import { historyPinUnavailableTooltip } from "@/components/epics/history-pin-availability";
import { negotiatedSetPinnedServesLocalHome } from "@/lib/epic-pin-admission";
import { readNegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import { toast } from "sonner";

/**
 * Thrown from `onMutate` when the session holds no cloud verdict at dispatch
 * AND the write is not the local-home one carved out below.
 *
 * Every surface that dispatches this (the desktop History row, the mobile
 * action tray, the tab strip and its Undo toast) admits the control from a
 * RENDER-time verdict. A control rendered while verified and activated after
 * a demotion, or an Undo toast outliving the click, would otherwise spend a
 * cloud capability on a bearer the cloud stopped vouching for; the host
 * connection carries no renderer verdict of its own. Gated in the one
 * mutation every consumer shares, so no consumer can omit it. Same shape as
 * the comment writes' `COMMENT_WRITE_UNAUTHORIZED_MESSAGE`.
 *
 * THIS USED TO SAY `epic.setPinned` IS CLOUD-ONLY. It no longer is. On
 * `@1.1` the host's pin resolver admits a local-homed epic on the local
 * `epicHomeVerdict` alone and returns before it builds any cloud header, so a
 * pin on such an epic spends NO cloud capability and refusing it without a
 * verdict would deny an offline or free-tier user a write their own machine
 * can serve. {@link isLocalHomePinExempt} is that carve-out, and it is
 * deliberately narrow: it needs BOTH the caller's local-home fact and a `@1.1`
 * negotiation re-read at dispatch, so a cloud-homed row, or a host that rolled
 * back to `@1.0` since the control rendered, still meets the gate.
 */
export const EPIC_PIN_UNAUTHORIZED_MESSAGE =
  "pin refused: the session holds no cloud verdict";

interface SetEpicPinnedMutationContext {
  readonly hostId: string | null;
  readonly userId: string | null;
}

export interface SetEpicPinnedVariables {
  readonly epicId: string;
  readonly pinned: boolean;
  /**
   * The host to dispatch on: the EPIC's host for a local-homed epic, `null` to
   * follow the window's.
   *
   * It has to be here, in the variables, rather than a parameter of the hook.
   * The pin is dispatched from surfaces that hold several epics on several hosts
   * behind ONE hook instance - the tab strip's menu, and the Undo action on the
   * toast that outlives the row's menu entirely - so a host bound at hook level
   * would be one machine's answer for all of them, and moving the hook per-row
   * would take Undo down with the row. `useHostMutation` accepts a function for
   * `client`, so the host can be resolved per dispatch from this field, and the
   * Undo closure carries it the same way it already carries `isLocalHome`.
   *
   * Why it must be the epic's host and not any host: the resolver's local arm
   * asks `epicHomeVerdict(epicId)` on WHICHEVER host receives the call. Sent
   * elsewhere, that host has no such local epic, the verdict is not local, and
   * the request falls to the cloud arm - a cloud write for an epic the cloud has
   * no row for. Stripped by `mapVariables`; never reaches the wire.
   */
  readonly hostId: string | null;
  /**
   * Whether this epic is durable on the serving host's disk rather than in the
   * cloud - the caller's own reading, from the same `HistoryItem` /
   * `TaskPinnedState` the control rendered from.
   *
   * Taken from the caller rather than re-derived here on purpose: the render
   * decided availability from this fact, and a second derivation at dispatch
   * is how the two come to disagree. It is stripped by `mapVariables` and
   * never reaches the wire - the host reads durability from its own
   * `epicHomeVerdict`, and a client-asserted home would be a claim it has no
   * business trusting.
   */
  readonly isLocalHome: boolean;
}

/**
 * Personal, default-host-scoped history pin mutation.
 *
 * Optimistic by design (the justified response-equals-state case: the RPC's
 * `{ pinned }` response is exactly the bit the request wrote): `onMutate`
 * flips the row in the scoped first-page query cache and in every retained
 * "Show more" tail so the toggle renders instantly, and `onError` restores
 * the previous state with the inverse patch (each row's control is disabled
 * while its own mutation is pending, so the pre-mutate state is exactly the
 * opposite bit) plus the error toast.
 *
 * `onSuccess` then reconciles in the background: a pin reorders rows across
 * server page boundaries, which makes every retained pagination cursor
 * stale (a later "Show more" against an old cursor could silently skip
 * rows), so the scope's tails are reset - rejecting in-flight ones via the
 * generation guard - and the active first page refetches with no pending UI
 * while the optimistic state keeps rendering.
 */
export function useEpicSetPinned() {
  const followingClient = useHostClient();
  const binding = useHostBinding();
  const queryClient = useQueryClient();
  // Resolved PER DISPATCH from `variables.hostId`. `useHostMutation` takes
  // either a client or a function of the variables, which is what lets one hook
  // instance serve rows on different machines - see the field's own doc for why
  // binding a host at hook level cannot work here.
  const clientForVariables = useCallback(
    (variables: SetEpicPinnedVariables) =>
      variables.hostId === null
        ? followingClient
        : resolveNamedHostClient(binding, variables.hostId),
    [binding, followingClient],
  );
  // Generics spelled out because `SetEpicPinnedVariables` is WIDER than the
  // request schema - `isLocalHome` is a dispatch-side fact `mapVariables`
  // strips. `TVariables` otherwise defaults to the request shape, and the
  // widening would only surface as an error on `onMutate`'s annotation. Same
  // shape as `useProvidersCancelModelProviderAuth`.
  return useHostMutation<
    HostRpcRegistry,
    "epic.setPinned",
    SetEpicPinnedMutationContext,
    SetEpicPinnedVariables
  >({
    client: clientForVariables,
    method: "epic.setPinned",
    // `isLocalHome` is a DISPATCH-side fact, not a request field: the wire
    // shape stays `{ epicId, pinned }` exactly as the schema declares it.
    mapVariables: ({ epicId, pinned }) => ({ epicId, pinned }),
    options: {
      mutationKey: epicMutationKeys.setPinned(),
      onMutate: (
        variables: SetEpicPinnedVariables,
      ): SetEpicPinnedMutationContext => {
        // The host the request is ACTUALLY going to, resolved through the same
        // function the dispatch resolves it with. That is the point of doing it
        // here rather than reading the window's active host: the admission gate,
        // the optimistic patch's scope and the request now cannot disagree about
        // which machine they mean. Before this they could, and the gate was the
        // one that mattered - it asked whether the WINDOW's host negotiated
        // `@1.1` and then admitted a write that went to it for an epic it did
        // not own.
        const dispatchClient = clientForVariables(variables);
        const hostId = dispatchClient?.getActiveHostId() ?? null;
        // Before the optimistic patch: a refused dispatch reaches `onError`
        // with no context, and the inverse patch must have nothing to undo.
        if (!epicPinDispatchAdmitted(variables, hostId)) {
          throw new Error(EPIC_PIN_UNAUTHORIZED_MESSAGE);
        }
        const userId = dispatchClient?.getRequestContextUserId() ?? null;
        if (hostId !== null && userId !== null) {
          applyPinnedPatch(
            queryClient,
            { hostId, userId },
            variables.epicId,
            variables.pinned,
          );
        }
        return { hostId, userId };
      },
      onSuccess: async (
        _response,
        _variables,
        ctx: SetEpicPinnedMutationContext,
      ) => {
        if (ctx.hostId === null || ctx.userId === null) return;
        const scope = { hostId: ctx.hostId, userId: ctx.userId };
        resetCloudEpicTasksPagesForScope(ctx.hostId, ctx.userId);
        // Both predicates also match the per-host PIN READING cache, which for
        // a local-homed row is where the RENDERED pin state comes from. The
        // optimistic patch already reaches it; these two are what make the
        // committed state durable - an inactive reading is dropped so it is
        // re-read on next use, an active one refetches now. `scope.hostId` is
        // the DISPATCH host, which for such a row is the owner, and the reading
        // key is keyed by that same host, so the two agree by construction.
        queryClient.removeQueries({
          type: "inactive",
          predicate: (query) =>
            cloudEpicTasksQueryKeyMatchesScope(query.queryKey, scope) ||
            epicPinReadingQueryKeyMatchesScope(query.queryKey, scope),
        });
        await queryClient.invalidateQueries({
          type: "active",
          predicate: (query) =>
            cloudEpicTasksQueryKeyMatchesScope(query.queryKey, scope) ||
            epicPinReadingQueryKeyMatchesScope(query.queryKey, scope),
        });
      },
      onError: (
        error,
        variables: SetEpicPinnedVariables,
        ctx: SetEpicPinnedMutationContext | undefined,
      ) => {
        if (ctx !== undefined && ctx.hostId !== null && ctx.userId !== null) {
          applyPinnedPatch(
            queryClient,
            { hostId: ctx.hostId, userId: ctx.userId },
            variables.epicId,
            !variables.pinned,
          );
        }
        if (error.message === EPIC_PIN_UNAUTHORIZED_MESSAGE) {
          toast.error(historyPinUnavailableTooltip("unverified-session"));
          return;
        }
        toastFromHostError(error, "Couldn't update pinned task.");
      },
    },
  });
}

/**
 * Whether this pin dispatch may proceed, read against the LIVE session verdict
 * and the LIVE negotiation rather than anything captured at render.
 *
 * Exported because the tab strip guards its own two entry points with it - the
 * menu select and the Undo toast action, which silently no-op rather than
 * dispatching a write `onMutate` would only throw back. That edge and
 * `onMutate` are the same decision, so they call the same function: two doors
 * making one decision in two places is how they come to disagree, and the
 * disagreement here is silent (a control that fires and does nothing, or a
 * refusal for a write the host would have served).
 *
 * `hostId` must be the host the write is DISPATCHED to, which is now
 * `variables.hostId` resolved through the same function the request uses - the
 * epic's own host for a local-homed row, the window's for everything else.
 *
 * This paragraph used to say it was `useHostClient()` "in both places", and that
 * consistency was the defect rather than the safeguard: the gate asked whether
 * the WINDOW's host negotiated `@1.1`, the answer was frequently yes, and the
 * write then went to that host for an epic living on another one - where
 * `epicHomeVerdict` is not local, so it fell through to a cloud write for an
 * epic with no cloud row. Two doors agreeing about the wrong machine.
 */
export function epicPinDispatchAdmitted(
  variables: SetEpicPinnedVariables,
  followingHostId: string | null,
): boolean {
  // The ONLY place the promotion "the epic's host, else the window's" is
  // written. Every door passes the host it happens to know - the tab strip the
  // window's, `onMutate` the dispatch client's own answer - and the promotion
  // here makes those agree. A second copy at a call site would be the shape
  // this function exists to prevent (its own doc: two doors making one decision
  // come to disagree), so there is no exported helper for it either.
  const dispatchHostId = variables.hostId ?? followingHostId;
  if (isLocalHomePinExempt(variables, dispatchHostId)) return true;
  return authorizesCloudCapability(useAuthStore.getState().status);
}

/**
 * Whether this dispatch is the cloud-free local-home write, and therefore not
 * subject to {@link EPIC_PIN_UNAUTHORIZED_MESSAGE}.
 *
 * BOTH conjuncts are required and neither is redundant. `isLocalHome` alone
 * would exempt a local-homed epic on a `@1.0` host, whose only arm is the
 * cloud one - the exemption would hand it an unverified bearer for exactly the
 * write it cannot serve. The negotiation alone would exempt every pin on a
 * `@1.1` host, including cloud-homed rows that do spend the capability.
 *
 * The version is re-read HERE rather than closed over at render, matching the
 * verdict read beside it and for the same reason: the tab strip's Undo toast
 * outlives its click, and a host can restart or roll back under the same id in
 * between. A `null` host id or an unknown manifest fails closed through
 * `negotiatedSetPinnedServesLocalHome`, which lands the caller back on the
 * cloud gate - the strictly safer of the two answers.
 */
function isLocalHomePinExempt(
  variables: SetEpicPinnedVariables,
  hostId: string | null,
): boolean {
  if (!variables.isLocalHome || hostId === null) return false;
  return negotiatedSetPinnedServesLocalHome(
    readNegotiatedMethodVersion(hostId, "epic.setPinned"),
  );
}

function applyPinnedPatch(
  queryClient: QueryClient,
  scope: { readonly hostId: string; readonly userId: string },
  epicId: string,
  pinned: boolean,
): void {
  setEpicPinnedInCloudTaskCaches(queryClient, scope, epicId, pinned);
  setCloudEpicTasksPagePinned(scope.hostId, scope.userId, epicId, pinned);
}

/**
 * epicIds with an in-flight `epic.setPinned` mutation. `useEpicSetPinned()`
 * is a single mutation instance shared across every history row, so reading
 * `.isPending`/`.variables` off it only ever reflects the most-recently
 * fired call - a second row's click would make an earlier still-pending row
 * read as idle. Reading every pending mutation with this shared key from the
 * mutation cache instead lets each row track its own request independently.
 */
export function usePendingSetPinnedEpicIds(): ReadonlySet<string> {
  const pendingVariables = useMutationState({
    filters: {
      mutationKey: epicMutationKeys.setPinned(),
      status: "pending",
    },
    select: (mutation) => mutation.state.variables,
  });

  return useMemo(
    () =>
      new Set(
        pendingVariables.flatMap((variables) =>
          isSetEpicPinnedVariables(variables) ? [variables.epicId] : [],
        ),
      ),
    [pendingVariables],
  );
}

/**
 * The part of {@link SetEpicPinnedVariables} this identification needs.
 *
 * Narrower than the variables type on purpose - see the guard below.
 */
type PendingSetPinnedIdentity = {
  readonly epicId: string;
  readonly pinned: boolean;
};

/**
 * Identifies a pending pin dispatch well enough to read its `epicId`.
 *
 * It deliberately does NOT require `isLocalHome`, even though every real
 * dispatch carries it. This runs over variables the mutation cache has ALREADY
 * scoped by `epicMutationKeys.setPinned()`, so it discriminates nothing that
 * the key has not - it only decides whether the shape is readable. Adding the
 * new field to it made a widening of the variables type silently shrink the
 * PENDING set instead: an entry that fails this guard is dropped, each row
 * reads its own write as settled, and the control un-disables mid-flight. That
 * fails OPEN - the row looks idle while its write is in the air - which is the
 * direction a guard must never fail in, and no type error can catch it because
 * the input is `unknown` by construction.
 */
function isSetEpicPinnedVariables(
  value: unknown,
): value is PendingSetPinnedIdentity {
  if (value === null || typeof value !== "object") return false;
  return (
    "epicId" in value &&
    typeof value.epicId === "string" &&
    "pinned" in value &&
    typeof value.pinned === "boolean"
  );
}
