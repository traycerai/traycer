import { lazy, Suspense, useEffect, type RefObject } from "react";
import { toast } from "sonner";
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
import { useEnvironmentReviewRead } from "@/hooks/environment/use-environment-reads";
import { useRetrospectiveSheetStore } from "@/stores/settings/retrospective-sheet-store";

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
  const held = useHeldOnThisComputer(computer, completedAt !== null);
  // Neither toast until the review answers, so the reminder never shows for
  // a moment before the held toast replaces it.
  if (held === "pending") return null;
  if (held === "held") return <HeldOnThisComputerToast computer={computer} />;
  return <SetupReminderToast completedAt={completedAt} />;
}

/**
 * Whether anything this computer's earlier upload held waits on a choice:
 * `pending` while its review is still being read, `clear` with no local host,
 * a host without the method, a failed read, or nothing held.
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
  if (review.supported === false || review.isError) return "clear";
  if (review.data === null) return "pending";
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

function SetupReminderToast(props: { readonly completedAt: number | null }) {
  const { completedAt } = props;
  const dismissed = useOnboardingStore((state) => state.setupReminderDismissed);
  const dismiss = useOnboardingStore((state) => state.dismissSetupReminder);
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
    if (completedAt === null || remaining === 0 || dismissed) return;
    let mounted = true;
    const id = "traycer-getting-started";
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
        if (mounted) dismiss();
      },
      action: {
        label: "Open",
        onClick: () => {
          dismiss();
          navigateToSettingsSection("getting-started");
        },
      },
    });
    return () => {
      mounted = false;
      toast.dismiss(id);
    };
  }, [completedAt, remaining, dismissed, dismiss]);
  return null;
}
