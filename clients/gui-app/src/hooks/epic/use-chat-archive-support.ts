import {
  useHostMethodSupport,
  useHostSupportsMethod,
} from "@/hooks/host/use-host-supports-method";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";

/**
 * The archive RPC's method name, shared by the capability gate and the mutation
 * so the two can never name different methods.
 */
export const SET_CHAT_ARCHIVED_METHOD = "epic.setChatArchived";

/**
 * Whether archive affordances should be offered at all.
 *
 * `epic.setChatArchived` is registered OFF the released floor with
 * `degrade: { kind: "unsupported" }`, so a host predating it negotiates the
 * method away rather than failing the handshake - and every archive affordance
 * (row hover button, row-menu entry, "Show archived") has to disappear on such
 * a host instead of offering an action that cannot work.
 *
 * Scoped to the tab's lifetime-bound host, matching `useEpicArchiveChat`'s
 * `useTabHostClient()`. The app-wide active host can change while the tab stays
 * open, so reading its manifest here could expose an action that the actual tab
 * host does not support (or hide one that it does).
 *
 * Fails closed while the host's manifest is still unknown - see
 * {@link useHostSupportsMethod}.
 */
export function useChatArchiveSupported(): boolean {
  const tabHostId = useTabHostId();
  return useHostSupportsMethod(tabHostId, SET_CHAT_ARCHIVED_METHOD);
}

/**
 * The tri-state behind {@link useChatArchiveSupported}, for the one decision
 * that must not collapse it: whether to HIDE archived rows.
 *
 * Hiding and revealing are gated differently, and deliberately so. Every
 * archive *affordance* is hidden unless support is positively known
 * (`useChatArchiveSupported`, fail-closed). But hiding rows on a host that is
 * KNOWN to lack the method would strand them: the "Show archived" toggle, the
 * Unarchive entry and the empty-state hint are all capability-gated, so a row
 * archived on a newer host and then seen from an older one would be invisible
 * with nothing left to bring it back. Archived records must never become
 * unreachable, so a known-absent host stops hiding.
 *
 * `null` (pre-handshake) keeps hiding rather than revealing: revealing on
 * unknown would flash archived rows on every cold start and then hide them a
 * moment later, which is worse than the toggle appearing late.
 */
export function useChatArchiveSupportState(): boolean | null {
  const tabHostId = useTabHostId();
  return useHostMethodSupport(tabHostId, SET_CHAT_ARCHIVED_METHOD);
}
