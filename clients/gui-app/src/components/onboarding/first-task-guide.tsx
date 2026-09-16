import { lazy, Suspense, useEffect, type RefObject } from "react";
import { toast } from "sonner";
import { navigateToSettingsSection } from "@/lib/settings-navigation";
import {
  useOnboardingStore,
  SETUP_GUIDE_LENGTHS,
} from "@/stores/onboarding/onboarding-store";
import { useSessionImportRunStore } from "@/stores/session-import/session-import-run-store";
import { useFirstTaskGuideStore } from "@/stores/onboarding/first-task-guide-store";

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

function GettingStartedToast() {
  const completedAt = useOnboardingStore((state) => state.completedAt);
  const progress = useOnboardingStore((state) => state.setupProgress);
  const dismissed = useOnboardingStore((state) => state.setupReminderDismissed);
  const dismiss = useOnboardingStore((state) => state.dismissSetupReminder);
  const remaining = Object.entries(SETUP_GUIDE_LENGTHS).filter(
    ([id, length]) => progress[id as keyof typeof progress] < length,
  ).length;
  useEffect(() => {
    if (completedAt === null || remaining === 0 || dismissed) return;
    let mounted = true;
    const id = "traycer-getting-started";
    toast("Make Traycer yours", {
      id,
      description: "Explore optional setup guides.",
      duration: Infinity,
      closeButton: true,
      onDismiss: () => {
        if (mounted) dismiss();
      },
      action: {
        label: "Open guide",
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
