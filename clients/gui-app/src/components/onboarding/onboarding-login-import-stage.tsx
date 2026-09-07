import { useEffect, type ReactNode } from "react";
import { ImportLoginsFlow } from "@/components/settings/import-logins-flow";
import { PLAIN_IMPORT_LOGINS_FRAME } from "@/components/settings/import-logins-frame";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import { useFeatureAnnouncementsStore } from "@/stores/settings/feature-announcements-store";

/** Showing this act is the announcement: the feature id is consumed on mount so the release toast never follows
 * for a user who has seen the act, whether or not they imported anything. */
export function OnboardingLoginImportStage(): ReactNode {
  const browserView = useRunnerHostOrNull()?.browserView ?? null;
  const consume = useFeatureAnnouncementsStore((state) => state.consume);
  useEffect(() => {
    consume("login-import");
  }, [consume]);
  if (browserView === null) return null;
  return (
    <div
      data-testid="onboarding-login-import-stage"
      className="flex h-[var(--onboarding-diorama-max-height)] w-full min-w-0 flex-col overflow-hidden rounded-xl border border-white/12 bg-background text-foreground shadow-[0_2rem_4rem_-1.75rem_rgba(0,0,0,0.72),0_0.875rem_2rem_-1.25rem_rgba(0,0,0,0.55)]"
    >
      <header className="relative flex h-10 shrink-0 items-center justify-center bg-canvas px-3 text-canvas-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-border/90 after:content-['']">
        <div
          aria-hidden="true"
          className="absolute left-3 flex items-center gap-1.5"
        >
          <span className="size-2 rounded-full bg-[#ff5f57]" />
          <span className="size-2 rounded-full bg-[#ffbd2e]" />
          <span className="size-2 rounded-full bg-[#28c840]" />
        </div>
        <span className="min-w-0 truncate text-ui-xs text-muted-foreground">
          Your logins on this machine
        </span>
      </header>
      {/* The flow's steps lay out with the dialog's gap; the window scrolls
          as one so a long site list stays inside the diorama's height. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 text-ui-sm">
        <ImportLoginsFlow
          browserView={browserView}
          enabled
          frame={PLAIN_IMPORT_LOGINS_FRAME}
          onFinished={null}
        />
      </div>
    </div>
  );
}
