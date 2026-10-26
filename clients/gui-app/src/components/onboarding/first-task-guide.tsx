import { lazy, Suspense, useEffect, useRef, type RefObject } from "react";
import { toast } from "sonner";
import {
  captureOnboardingReminderIdentity,
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
import { planesNotMoved } from "@/components/settings/move/cohort-rows";
import { planesFromStatus } from "@/components/settings/move/status-planes";
import {
  useEnvironmentReviewRead,
  useEnvironmentStatusRead,
} from "@/hooks/environment/use-environment-reads";
import { useRetrospectiveSheetStore } from "@/stores/settings/retrospective-sheet-store";
import { usePreviewFeature } from "@/hooks/auth/use-preview-feature";
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
  // Nothing moves or is held without environments: the plain reminder.
  const environments = usePreviewFeature("environments");
  const reads = completedAt !== null && environments === "on";
  const held = useHeldOnThisComputer(computer, reads);
  const notMoved = useNotMovedOnThisComputer(computer, reads);
  // Neither toast until the review and the status answer, so the reminder
  // never shows for a moment before another toast replaces it. Unread waits
  // the same way: the verdict may yet turn the reads on.
  if (environments === "unread") return null;
  if (held === "pending" || notMoved === "pending") return null;
  if (held === "held") return <HeldOnThisComputerToast computer={computer} />;
  const moveTarget =
    notMoved === "not_moved" && computer.hostId !== null
      ? { hostId: computer.hostId, hostName: computer.hostName }
      : null;
  return (
    <SetupReminderToast completedAt={completedAt} moveTarget={moveTarget} />
  );
}

/**
 * Whether nothing of this computer's settings has moved and the move still
 * waits for the person: `pending` while its status is being read, `clear`
 * with no local host, a host without the method or its planes, a first read
 * that failed, an accepted move, or anything already in Personal. The status
 * is re-read every few seconds, and a re-read that fails keeps the last
 * answer: otherwise one failed read would take the move toast away unpressed.
 */
function useNotMovedOnThisComputer(
  computer: ThisComputer,
  enabled: boolean,
): "not_moved" | "clear" | "pending" {
  const status = useEnvironmentStatusRead(
    computer.client,
    computer.hostId,
    enabled,
  );
  if (!enabled || computer.hostId === null) return "clear";
  if (status.supported === false) return "clear";
  if (status.data === null) return status.isError ? "clear" : "pending";
  const planes = planesFromStatus(status.data);
  if (planes === null || status.data.consent !== null) return "clear";
  return planesNotMoved(planes, status.data.pendingUploads.length > 0)
    ? "not_moved"
    : "clear";
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
      description: <span className="text-pretty">Review</span>,
      duration: Infinity,
      closeButton: true,
      onDismiss: () => {
        if (mounted) dismiss();
      },
      action: {
        label: "Open",
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

/**
 * `moveTarget` names this computer when none of its settings are in Personal
 * yet: the reminder then says so and opens its move sheet instead of
 * Settings.
 */
function SetupReminderToast(props: {
  readonly completedAt: number | null;
  readonly moveTarget: MoveSheetTarget | null;
}) {
  const { completedAt } = props;
  const moveHostId = props.moveTarget?.hostId ?? null;
  const moveHostName = props.moveTarget?.hostName ?? null;
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
  // Declared first, so on unmount its cleanup runs before the toast's: the
  // toast stays until the person presses it or ×, even once the Start page is
  // left, and that × still records the dismissal. A change of what it says
  // still replaces it, and a later mount replaces it by its id.
  const unmounting = useRef(false);
  useEffect(() => {
    unmounting.current = false;
    return () => {
      unmounting.current = true;
    };
  }, []);
  useEffect(() => {
    if (completedAt === null || dismissed) return;
    // The setup count gates only the setup reminder: a computer whose
    // settings have not moved still has that to do with every guide done.
    if (remaining === 0 && moveHostId === null) return;
    let mounted = true;
    const id = ONBOARDING_REMINDER_TOAST_ID;
    const identityIsCurrent = captureOnboardingReminderIdentity();
    if (moveHostId !== null && moveHostName !== null) {
      toast("This computer's settings aren't in Personal.", {
        id,
        description: (
          <span className="text-pretty">Move them to use them everywhere</span>
        ),
        duration: Infinity,
        closeButton: true,
        onDismiss: () => {
          if (mounted && identityIsCurrent()) dismiss();
        },
        action: {
          label: "Show me what moves",
          onClick: () => {
            if (!identityIsCurrent()) return;
            dismiss();
            openMoveSheet({ hostId: moveHostId, hostName: moveHostName });
          },
        },
      });
      return () => {
        if (unmounting.current) return;
        mounted = false;
        toast.dismiss(id);
      };
    }
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
  }, [
    completedAt,
    remaining,
    dismissed,
    dismiss,
    moveHostId,
    moveHostName,
    openMoveSheet,
  ]);
  return null;
}
