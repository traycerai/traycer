import { AlertTriangle } from "lucide-react";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";

export function ProfileDisabledBanner({
  profileLabel,
  enablePending,
  onEnableProfile,
  onChooseProfile,
}: {
  readonly profileLabel: string | null;
  readonly enablePending: boolean;
  readonly onEnableProfile: () => void;
  readonly onChooseProfile: () => void;
}) {
  return (
    <div
      role="status"
      className="mb-3 flex w-full items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-ui-sm"
    >
      <AlertTriangle
        className="mt-0.5 size-3.5 shrink-0 text-destructive"
        aria-hidden
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div>
          <div className="font-medium text-foreground">Profile disabled</div>
          <div className="text-muted-foreground">
            {profileLabel ?? "This profile"} cannot start new work.
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={enablePending}
            onClick={onEnableProfile}
          >
            {enablePending ? <MutedAgentSpinner /> : null}
            Enable profile
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onChooseProfile}
          >
            Choose profile
          </Button>
        </div>
      </div>
    </div>
  );
}
