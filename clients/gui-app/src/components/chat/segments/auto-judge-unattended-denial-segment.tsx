import { Gavel } from "lucide-react";
import { autoJudgeUnattendedDenialText } from "@/components/chat/segments/auto-judge-unattended-denial-display";

interface AutoJudgeUnattendedDenialSegmentProps {
  readonly rule: string | null;
  readonly reason: string | null;
}

/**
 * An auto-mode refusal that was never put to a person.
 *
 * Under the attendance rule a chat a human created and merely looked away from
 * PARKS its card and waits. A chat an agent created, with nobody subscribed,
 * does not: parking there is a promise to a person who does not exist, and it
 * would pin the session for the host's life - so the judge's refusal becomes a
 * tool error the model reads, and the run continues.
 *
 * That leaves the human who opens the chat tomorrow as its only other reader,
 * and until this row they had nothing: a denial with no card looks exactly like
 * a judge that simply refused. "Refused without asking" names the thing they
 * would otherwise have to infer.
 *
 * `role="note"` for the same reason as the provenance marker beside it -
 * ancillary content about the conversation rather than part of it.
 */
export function AutoJudgeUnattendedDenialSegment(
  props: AutoJudgeUnattendedDenialSegmentProps,
) {
  return (
    <div
      role="note"
      data-testid="auto-judge-unattended-denial"
      className="flex w-full min-w-0 items-start gap-2 py-2 text-ui-xs text-muted-foreground"
    >
      <Gavel className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <p className="m-0 min-w-0 text-pretty" data-find-include="true">
        {autoJudgeUnattendedDenialText(props)}
      </p>
    </div>
  );
}
