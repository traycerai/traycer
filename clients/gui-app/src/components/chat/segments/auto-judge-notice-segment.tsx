import { ShieldAlert } from "lucide-react";
import type { AutoJudgeNoticeMarker } from "@traycer/protocol/persistence/chat-transcript/row-order";

interface AutoJudgeNoticeSegmentProps {
  readonly marker: AutoJudgeNoticeMarker;
  readonly message: string;
}

/**
 * A line the auto-mode judge owes the user, once per session per kind: the
 * judge could not run and commands are coming to them instead, a policy file
 * is not (wholly) the one deciding, or Automatic moved the judge off Traycer
 * inference onto the conversation's own provider - billed to their account
 * there. The composer describes the judge the host is CONFIGURED to use; only
 * this row says what happened at run time.
 *
 * The text is the host's, verbatim: it names the harness, the policy path or
 * the reason, and nothing here could say it more precisely. `role="note"`
 * like the other synthesized rows beside it, with the warning token on the
 * icon because the host journals every one of these at warning severity.
 */
export function AutoJudgeNoticeSegment(props: AutoJudgeNoticeSegmentProps) {
  return (
    <div
      role="note"
      data-testid="auto-judge-notice"
      data-auto-judge-notice={props.marker}
      className="flex w-full min-w-0 items-start gap-2 py-2 text-ui-xs text-muted-foreground"
    >
      <ShieldAlert
        className="mt-0.5 size-3.5 shrink-0 text-warning-foreground"
        aria-hidden
      />
      <p className="m-0 min-w-0 text-pretty" data-find-include="true">
        {props.message}
      </p>
    </div>
  );
}
