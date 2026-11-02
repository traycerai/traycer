import { lazy, Suspense, useEffect, type RefObject } from "react";
import { toast } from "sonner";
import {
  captureOnboardingReminderIdentity,
  markMoveInvitationAnswered,
  markMoveInvitationShown,
  moveInvitationIsOutstanding,
  MOVE_INVITATION_TOAST_ID,
  ONBOARDING_REMINDER_TOAST_ID,
} from "@/lib/toast/onboarding-reminder-toast";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import {
  useOnboardingStore,
  onboardingCompletedCount,
  onboardingGuideCount,
} from "@/stores/onboarding/onboarding-store";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import { useSessionImportRunStore } from "@/stores/session-import/session-import-run-store";
import { useFirstTaskGuideStore } from "@/stores/onboarding/first-task-guide-store";
import { heldReviewEntries } from "@/components/settings/move/held-from-review";
import {
  useThisComputer,
  type ThisComputer,
} from "@/components/settings/move/this-computer";
import { useThisComputersMove } from "@/components/settings/move/use-this-computers-move";
import { useEnvironmentReviewRead } from "@/hooks/environment/use-environment-reads";
import { useRetrospectiveSheetStore } from "@/stores/settings/retrospective-sheet-store";
import {
  useMoveSheetStore,
  type MoveSheetTarget,
} from "@/stores/settings/move-sheet-store";

export function FirstTaskImportBridge() {
  useEffect(() => {
    const observe = (): void =>
      useFirstTaskGuideStore
        .getState()
        .observeImports(useSessionImportRunStore.getState());
    observe();
    return useSessionImportRunStore.subscribe(observe);
  }, []);
  return null;
}

const LandingGuide = lazy(() =>
  import("./first-task-landing-guide").then((module) => ({
    default: module.FirstTaskLandingGuide,
  })),
);
const ChatGuide = lazy(() =>
  import("./first-task-landing-guide").then((module) => ({
    default: module.FirstTaskChatGuide,
  })),
);

export function FirstTaskLandingGuide(props: {
  readonly enabled: boolean;
  readonly rootRef: RefObject<HTMLElement | null>;
  readonly workspaceFolders: readonly string[] | null;
}) {
  const active = useFirstTaskGuideStore((state) => state.status === "active");
  if (!props.enabled) return null;
  if (!active) return <GettingStartedToast />;
  return (
    <Suspense fallback={null}>
      <LandingGuide
        rootRef={props.rootRef}
        workspaceFolders={props.workspaceFolders}
      />
    </Suspense>
  );
}

export function FirstTaskChatGuide(props: {
  readonly enabled: boolean;
  readonly rootRef: RefObject<HTMLElement | null>;
  readonly hostId: string | null;
  readonly chatId: string;
}) {
  const active = useFirstTaskGuideStore((state) => state.status === "active");
  if (!active || !props.enabled) return null;
  return (
    <Suspense fallback={null}>
      <ChatGuide
        rootRef={props.rootRef}
        hostId={props.hostId}
        chatId={props.chatId}
      />
    </Suspense>
  );
}

/**
 * The Start toast. While anything an earlier version shared from this
 * computer is on hold it reads `An earlier version shared this computer's
 * settings · Review` and opens the retrospective sheet, instead of the setup
 * reminder; it retires by itself once nothing is on hold.
 */
function GettingStartedToast() {
  const computer = useThisComputer();
  const completedAt = useOnboardingStore((state) => state.completedAt);
  const remindersOn = completedAt !== null;
  const held = useHeldOnThisComputer(computer, remindersOn);
  const move = useThisComputersMove(computer, remindersOn);
  // No toast until the review and the status answer, so none shows for a
  // moment before another replaces it.
  if (held === "pending" || move === "pending") return null;
  if (held === "held") return <HeldOnThisComputerToast computer={computer} />;
  const moveTarget =
    move === "not_moved" && computer.hostId !== null
      ? { hostId: computer.hostId, hostName: computer.hostName }
      : null;
  return <StartToast completedAt={completedAt} moveTarget={moveTarget} />;
}

/**
 * The Start page's two toasts, under two ids: the move's invitation while
 * this computer's settings are not in Personal, and the setup reminder
 * otherwise. The invitation wins while there is one - two things asking for
 * the next move at once is noise - and the reminder is held back for as long
 * as one has been shown and not answered.
 *
 * Once shown, the invitation stands until the person presses it, answers Not
 * now, or ×s it. A status that stops naming a move - a host swap, a version
 * without the planes, a move accepted elsewhere - is not an answer from the
 * person: it neither withdraws the invitation nor lets the reminder take its
 * place. Both effects live here, the invitation's first, so the reminder's
 * reads an invitation shown on an earlier render - and the fact that one is
 * outstanding lives with the toast's identity rather than here, because the
 * toast outlives this component: the Start page is left and comes back while
 * the invitation stays up.
 */
function StartToast(props: {
  readonly completedAt: number | null;
  readonly moveTarget: MoveSheetTarget | null;
}) {
  const { completedAt } = props;
  const hostId = props.moveTarget?.hostId ?? null;
  const hostName = props.moveTarget?.hostName ?? null;
  const dismissed = useOnboardingStore((state) => state.setupReminderDismissed);
  const dismiss = useOnboardingStore((state) => state.dismissSetupReminder);
  const openMoveSheet = useMoveSheetStore((state) => state.openSheet);
  // Availability, not just completion: a guide this build cannot offer would
  // otherwise leave a nudge that can never be satisfied, pointing at a card
  // that cannot be opened.
  const browserView = useRunnerHostOrNull()?.browserView ?? null;
  const shell = { browserView: browserView !== null };
  const complete = useOnboardingStore((state) =>
    onboardingCompletedCount(state, shell),
  );
  const remaining = onboardingGuideCount(shell) - complete;
  useEffect(() => {
    if (dismissed || hostId === null || hostName === null) return;
    markMoveInvitationShown();
    const identityIsCurrent = captureOnboardingReminderIdentity();
    // The invitation's shape is the import announcement's
    // (`session-import-announcement-controller.tsx`): it does not time out,
    // and only the person takes it down - which is why there is nothing to
    // undo here. ×, Not now and the action each dismiss it themselves, and a
    // sign-out retires it (`retireOnboardingReminder`).
    toast("This computer's settings aren't in Personal.", {
      id: MOVE_INVITATION_TOAST_ID,
      description: (
        <span className="text-pretty">Move them to use them everywhere</span>
      ),
      duration: Infinity,
      closeButton: true,
      onDismiss: () => {
        if (!identityIsCurrent()) return;
        markMoveInvitationAnswered();
        dismiss();
      },
      action: {
        label: "Show me what moves",
        onClick: () => {
          if (!identityIsCurrent()) return;
          markMoveInvitationAnswered();
          dismiss();
          openMoveSheet({ hostId, hostName });
        },
      },
      cancel: {
        label: "Not now",
        onClick: () => {
          if (!identityIsCurrent()) return;
          markMoveInvitationAnswered();
          dismiss();
        },
      },
    });
  }, [dismissed, dismiss, hostId, hostName, openMoveSheet]);
  useEffect(() => {
    if (completedAt === null || dismissed) return;
    if (remaining === 0) return;
    // An invitation on screen is the thing being asked; the reminder waits
    // for it to be answered, whatever the status says by now and whether or
    // not this instance is the one that published it.
    if (hostId !== null || moveInvitationIsOutstanding()) return;
    let mounted = true;
    const id = ONBOARDING_REMINDER_TOAST_ID;
    const identityIsCurrent = captureOnboardingReminderIdentity();
    toast("You're all set", {
      id,
      // `text-pretty` rather than the default: on a phone this line wraps, and
      // the old sentence left "Getting started." alone on a second line with a
      // ›-separated path the user cannot tap. Shorter copy, and the wrap is
      // balanced where it does happen.
      description: (
        <span className="text-pretty">More setup is in Settings.</span>
      ),
      duration: Infinity,
      closeButton: true,
      onDismiss: () => {
        if (mounted && identityIsCurrent()) dismiss();
      },
      action: {
        label: "Open",
        onClick: () => {
          if (!identityIsCurrent()) return;
          dismiss();
          navigateToSettingsSection("getting-started");
        },
      },
    });
    return () => {
      mounted = false;
      toast.dismiss(id);
    };
  }, [completedAt, remaining, dismissed, dismiss, hostId]);
  return null;
}

/**
 * Whether anything this computer's earlier upload held waits on a choice:
 * `pending` while its review is still being read, `clear` with no local host,
 * a host without the method, a first read that failed, or nothing held.
 */
function useHeldOnThisComputer(
  computer: ThisComputer,
  enabled: boolean,
): "held" | "clear" | "pending" {
  const review = useEnvironmentReviewRead(
    computer.client,
    computer.hostId,
    enabled,
  );
  if (!enabled || computer.hostId === null) return "clear";
  if (review.supported === false) return "clear";
  // A re-read that fails keeps the last answer, as the status does.
  if (review.data === null) return review.isError ? "clear" : "pending";
  return heldReviewEntries(review.data.entries).length > 0 ? "held" : "clear";
}

const HELD_TOAST_ID = "traycer-held-on-this-computer";

function HeldOnThisComputerToast(props: { readonly computer: ThisComputer }) {
  const dismissed = useRetrospectiveSheetStore(
    (state) => state.heldToastDismissed,
  );
  const dismiss = useRetrospectiveSheetStore((state) => state.dismissHeldToast);
  const openSheet = useRetrospectiveSheetStore((state) => state.openSheet);
  const { hostId, hostName } = props.computer;
  useEffect(() => {
    if (dismissed || hostId === null) return;
    let mounted = true;
    toast("An earlier version shared this computer's settings", {
      id: HELD_TOAST_ID,
      // The verb is the toast's own action - `… · Review` - so there is no
      // line under it repeating the word it is already pressing.
      description: null,
      duration: Infinity,
      closeButton: true,
      onDismiss: () => {
        if (mounted) dismiss();
      },
      action: {
        label: "Review",
        onClick: () => {
          dismiss();
          openSheet({ hostId, hostName });
        },
      },
    });
    return () => {
      mounted = false;
      toast.dismiss(HELD_TOAST_ID);
    };
  }, [dismissed, hostId, hostName, dismiss, openSheet]);
  return null;
}
