import { ShieldCheck } from "lucide-react";
import { autoJudgeUnattendedDenialText } from "@/components/chat/segments/auto-judge-unattended-denial-display";

interface AutoJudgeUnattendedDenialSegmentProps {
  readonly rule: string | null;
  readonly reason: string | null;
}

/**
 * An auto-mode refusal that was never put to a person.
 *
 * Hosts used to refuse a judge-escalated approval in a chat an agent created,
 * with nobody subscribed, instead of parking its card: the refusal became a
 * tool error the model read, and the run continued. Hosts now park those
 * cards for a person and write no such denial; journals from before still
 * carry them.
 *
 * The human who opens such a chat later is the denial's only other reader,
 * and without this row a denial with no card looks exactly like a judge that
 * simply refused. "Refused without asking" names the thing they would
 * otherwise have to infer.
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
      <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <p className="m-0 min-w-0 text-pretty" data-find-include="true">
        {autoJudgeUnattendedDenialText(props)}
      </p>
    </div>
  );
}
