/**
 * Owner-side chat-sharing decisions, as data.
 *
 * The row menu, the shared-with-task glyph, and the sharing-panel master
 * toggle all read the same facts (capability, current visibility, whether
 * anyone else is on the task). Keeping the predicates here means the three
 * surfaces cannot disagree about when an affordance appears or what it says.
 */

export const UNPUBLISHED_SHARING_TOOLTIP =
  "Publishes shortly; it will follow your task sharing setting";

export const SHARED_WITH_TASK_TOOLTIP = "Shared with task";

export type ChatSharingMenuAction = "share" | "make-private";

export type ChatSharingMenuDecision =
  | { readonly kind: "hidden" }
  | {
      readonly kind: "entry";
      readonly action: ChatSharingMenuAction;
      readonly disabled: boolean;
      readonly disabledTooltip: string | null;
    };

/**
 * Whether the Share / Make private row-menu entry should render, and in
 * which state.
 *
 * Hidden when the host does not advertise the RPC, and on terminal-agent
 * rows (terminal agents stay private). An unpublished chat — no folded cloud
 * row yet — still shows the entry, disabled, because `setVisibility` needs
 * the cloud row to exist and the create-arm default already encodes the
 * user's intent.
 */
export function decideChatSharingMenuEntry(input: {
  readonly supported: boolean;
  readonly isChat: boolean;
  readonly canMutate: boolean;
  readonly visibility: "private" | "task" | null;
  readonly pending: boolean;
}): ChatSharingMenuDecision {
  if (!input.supported || !input.isChat) return { kind: "hidden" };
  const unpublished = input.visibility === null;
  return {
    kind: "entry",
    action: input.visibility === "task" ? "make-private" : "share",
    disabled: !input.canMutate || unpublished || input.pending,
    // Only the unpublished arm explains itself. `!canMutate` greys out every
    // entry in the menu at once, so a per-entry tooltip there would be noise.
    // Pending is a transient in-flight mutation and likewise self-explanatory.
    disabledTooltip:
      input.canMutate && unpublished ? UNPUBLISHED_SHARING_TOOLTIP : null,
  };
}

/**
 * Own local rows show a Users glyph only when the chat is task-visible AND
 * someone else can actually see it. Private stays quiet; a solo task has no
 * audience, so the glyph would be a lie.
 */
export function shouldShowSharedWithTaskIndicator(input: {
  readonly visibility: "private" | "task" | null;
  readonly hasCollaborators: boolean;
}): boolean {
  return input.visibility === "task" && input.hasCollaborators;
}

/**
 * Initial master-toggle state when the server pref has no read endpoint:
 * all of the viewer's own cloud rows private (or none yet) → off, otherwise
 * on. The toggle always writes `applyToExisting: true`, so the ambiguity is
 * acceptable — the next flip is authoritative either way.
 */
export function deriveChatSharingDefaultOn(
  ownChats: readonly { readonly visibility: "private" | "task" }[],
): boolean {
  return ownChats.some((chat) => chat.visibility === "task");
}

/** Own cloud rows that a share-direction master toggle is about to expose. */
export function countOwnPrivateChats(
  ownChats: readonly { readonly visibility: "private" | "task" }[],
): number {
  return ownChats.reduce(
    (count, chat) => (chat.visibility === "private" ? count + 1 : count),
    0,
  );
}

/**
 * A task is solo until a second person (or a team grant) is in evidence.
 * Unknown (query still loading) is treated as solo so the glyph cannot flash
 * on a private-looking task and then vanish.
 */
export function taskHasCollaborators(
  view:
    | {
        readonly directUsers: readonly unknown[];
        readonly teams: readonly unknown[];
      }
    | undefined,
): boolean {
  if (view === undefined) return false;
  return view.directUsers.length > 1 || view.teams.length > 0;
}
