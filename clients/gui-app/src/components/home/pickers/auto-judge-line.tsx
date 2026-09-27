import type { ReactNode } from "react";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { normalizeProviderId } from "@/components/home/data/landing-options";
import type { AutoJudgeRowFace } from "@/lib/auto-mode/auto-judge-billing";
import { cn } from "@/lib/utils";

/**
 * The Auto row's judge line, shared by the desktop dropdown and the mobile
 * sheet: the provider's icon and the model in foreground text, then who pays
 * behind a status dot, on one line that wraps the pocket, dot and all, onto
 * its own line when the row is too narrow.
 *
 * The separator between the model and the pocket is visual (the dot), so a
 * screen reader gets a spoken one instead.
 */
export function AutoJudgeLine(props: {
  readonly face: AutoJudgeRowFace;
  readonly testId: string;
}): ReactNode {
  const { face } = props;
  const providerId =
    face.judge === null ? null : normalizeProviderId(face.judge.harnessId);
  return (
    <span
      data-testid={props.testId}
      className="mt-1 flex min-w-0 flex-col text-ui-xs text-muted-foreground"
    >
      <span className="flex min-w-0 flex-wrap items-center gap-x-3">
        {face.judge !== null ? (
          <span className="flex min-w-0 items-center gap-1.5 text-ui-sm text-foreground">
            {providerId !== null ? (
              <HarnessIcon harnessId={providerId} className="size-3.5" />
            ) : null}
            <span className="min-w-0">{face.judge.label}</span>
            <span className="sr-only"> · </span>
          </span>
        ) : null}
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              face.tone === "success" ? "bg-success" : "bg-warning",
            )}
          />
          <span className="min-w-0">
            {face.pocket.before}
            {face.pocket.emphasis !== null ? (
              <span className="font-medium text-foreground">
                {face.pocket.emphasis}
              </span>
            ) : null}
            {face.pocket.after}
          </span>
        </span>
      </span>
      {face.detail !== null ? (
        <span className="pl-3">{face.detail}</span>
      ) : null}
    </span>
  );
}
