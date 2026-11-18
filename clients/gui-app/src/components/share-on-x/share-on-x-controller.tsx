import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import {
  gateBlocksApp,
  useHostReadinessController,
  useSurfaceReadiness,
  windowNarratorOwns,
} from "@/components/layout/host-readiness-controller-context";
import { matchGratitude } from "@/components/share-on-x/gratitude-match";
import {
  ShareNudgeToastContent,
  type ShareNudgeChoice,
} from "@/components/share-on-x/share-nudge-toast";
import {
  captureAppWindow,
  canCaptureAppWindow,
  toShareImage,
  type ShareImage,
} from "@/components/share-on-x/share-images";
import { ShareOnXDialog } from "@/components/share-on-x/share-on-x-dialog";
import {
  subscribeSentChatMessages,
  type SentChatMessage,
} from "@/components/share-on-x/sent-messages";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { appLogger, describeLogErrorSummary } from "@/lib/logger";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useFirstTaskGuideStore } from "@/stores/onboarding/first-task-guide-store";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useOnboardingTourOpenStore } from "@/stores/onboarding/onboarding-tour-open-store";
import { useShareOnXNudgeStore } from "@/stores/settings/share-on-x-nudge-store";

const SHARE_NUDGE_TOAST_ID = "traycer-share-on-x-nudge";

interface OpenShareDialog {
  readonly epicId: string;
  readonly hostId: string | null;
  readonly screenCapture: ShareImage | null;
}

/**
 * Asks a person who just thanked an agent whether they would share Traycer
 * on X, and opens the share dialog when they say yes. Desktop only: the
 * dialog's first image is a screenshot of the window, which only the desktop
 * app can take.
 *
 * A thank-you shows the toast only when all of these hold:
 *
 * - the message matches the gratitude phrases (`matchGratitude`);
 * - the person is signed in, has finished onboarding, and neither the tour
 *   nor the first-task guide is on screen;
 * - the window narrator does not own the frame behind a blocking dialog,
 *   where a toast renders dead (the same check the announcements make);
 * - the install's record allows it (`isShareOnXNudgeEligible`) and this
 *   window wins the claim, so two windows never both ask.
 *
 * Every way the toast ends is recorded once: the countdown running out,
 * "Remind me later", the close button, "Don't ask again", or "Share on X"
 * (whose outcome the dialog records).
 */
export function ShareOnXController(): ReactNode {
  const signedIn = useAuthStore((state) => state.status === "signed-in");
  const onboardingComplete = useOnboardingStore(
    (state) => state.completedAt !== null,
  );
  const tourOpen = useOnboardingTourOpenStore((state) => state.open);
  const guideActive = useFirstTaskGuideStore(
    (state) => state.status === "active",
  );
  const readiness = useSurfaceReadiness("default-host", null);
  const { hasBeenDefaultHostReady } = useHostReadinessController();
  const narrated =
    windowNarratorOwns(readiness) &&
    !gateBlocksApp({
      readiness,
      hasBeenReady: hasBeenDefaultHostReady,
      signedIn,
      bypassed: false,
    });
  const noteSeen = useShareOnXNudgeStore((state) => state.noteSeen);
  const [dialog, setDialog] = useState<OpenShareDialog | null>(null);
  // The showing on screen now, if any. Settled once, whichever way it ends:
  // the toast's own close button reports through `onDismiss`, which also
  // fires when a choice dismisses it, and only the first report counts.
  const showingRef = useRef<{ settled: boolean } | null>(null);

  const desktop = canCaptureAppWindow();
  const canAsk =
    desktop &&
    signedIn &&
    onboardingComplete &&
    !tourOpen &&
    !guideActive &&
    !narrated;

  useEffect(() => {
    if (desktop && signedIn) noteSeen(Date.now());
  }, [desktop, noteSeen, signedIn]);

  const settle = useEffectEvent(
    (
      showing: { settled: boolean },
      choice: ShareNudgeChoice | "close",
      message: SentChatMessage,
    ) => {
      if (showing.settled) return;
      showing.settled = true;
      if (showingRef.current === showing) showingRef.current = null;
      toast.dismiss(SHARE_NUDGE_TOAST_ID);
      const store = useShareOnXNudgeStore.getState();
      const now = Date.now();
      switch (choice) {
        case "share":
          void captureAppWindow()
            .then((blob) => (blob === null ? null : toShareImage(blob)))
            .catch((error: unknown) => {
              appLogger.warn("[share-on-x] window capture failed", {
                error: describeLogErrorSummary(error),
              });
              return null;
            })
            .then((screenCapture) => {
              setDialog({
                epicId: message.epicId,
                hostId: message.hostId,
                screenCapture,
              });
            });
          return;
        case "remind_later":
          store.recordRemindLater(now);
          Analytics.getInstance().track(AnalyticsEvent.SharePromptDismissed, {
            via: "remind_later",
          });
          return;
        case "timeout":
          store.recordTimeout(now);
          Analytics.getInstance().track(AnalyticsEvent.SharePromptDismissed, {
            via: "timeout",
          });
          return;
        case "close":
          store.recordClose(now);
          Analytics.getInstance().track(AnalyticsEvent.SharePromptDismissed, {
            via: "close",
          });
          return;
        case "opt_out":
          store.recordOptOut();
          Analytics.getInstance().track(AnalyticsEvent.ShareOptedOut, {
            from: "toast",
          });
          return;
      }
    },
  );

  const onSentMessage = useEffectEvent((message: SentChatMessage) => {
    if (!canAsk || dialog !== null || showingRef.current !== null) return;
    const matchKey = matchGratitude(message.text);
    if (matchKey === null) return;
    const store = useShareOnXNudgeStore.getState();
    if (!store.claimShowing(Date.now())) return;
    const showing = { settled: false };
    showingRef.current = showing;
    Analytics.getInstance().track(AnalyticsEvent.SharePromptShown, {
      trigger: "gratitude",
      match_key: matchKey,
      showing: store.countedShowings + 1,
    });
    toast(
      <ShareNudgeToastContent
        onChoose={(choice) => settle(showing, choice, message)}
      />,
      {
        id: SHARE_NUDGE_TOAST_ID,
        duration: Infinity,
        onDismiss: () => settle(showing, "close", message),
      },
    );
  });

  useEffect(() => subscribeSentChatMessages(onSentMessage), []);

  // A gate that closes while the toast is up takes it down unrecorded: the
  // person never chose, so the claim's short cooldown stands.
  useEffect(() => {
    const showing = showingRef.current;
    if (canAsk || showing === null) return;
    showing.settled = true;
    showingRef.current = null;
    toast.dismiss(SHARE_NUDGE_TOAST_ID);
  }, [canAsk]);

  if (dialog === null) return null;
  return (
    <ShareOnXDialog
      open
      onClose={() => setDialog(null)}
      epicId={dialog.epicId}
      hostId={dialog.hostId}
      screenCapture={dialog.screenCapture}
    />
  );
}
