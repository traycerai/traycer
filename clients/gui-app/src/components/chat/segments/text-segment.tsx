import { useCallback, useMemo, useState } from "react";
import {
  parseTraycerNextStepsMarkdown,
  type TraycerNextStepsPart,
} from "@/markdown/traycer-next-steps";
import { withMemberAdded } from "@/lib/immutable-set";
import { AgentReferenceMarkdown } from "./agent-reference-markdown";
import {
  NextStepsActionGroup,
  type NextStepActionHandler,
} from "./next-steps-action-group";

interface TextSegmentProps {
  findUnitId: string | null;
  markdown: string;
  isStreaming: boolean;
  nextStepActions: NextStepActionHandler | null;
}

export function TextSegment(props: TextSegmentProps) {
  const parts = useMemo(
    () => parseTraycerNextStepsMarkdown(props.markdown, props.isStreaming),
    [props.isStreaming, props.markdown],
  );
  const [lockedBlockIds, setLockedBlockIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const lockBlock = useCallback((blockId: string) => {
    setLockedBlockIds((current) => withMemberAdded(current, blockId));
  }, []);

  return (
    <div
      data-chat-find-unit={props.findUnitId ?? undefined}
      className="text-ui leading-7 text-foreground"
    >
      {parts.map((part) => (
        <TextSegmentPart
          key={part.id}
          part={part}
          locked={lockedBlockIds.has(part.id)}
          isStreaming={props.isStreaming}
          nextStepActions={props.nextStepActions}
          onLock={lockBlock}
        />
      ))}
    </div>
  );
}

interface TextSegmentPartProps {
  readonly part: TraycerNextStepsPart;
  readonly locked: boolean;
  readonly isStreaming: boolean;
  readonly nextStepActions: NextStepActionHandler | null;
  readonly onLock: (blockId: string) => void;
}

function TextSegmentPart(props: TextSegmentPartProps) {
  const { part } = props;
  if (part.kind === "markdown") {
    return (
      <AgentReferenceMarkdown
        isStreaming={props.isStreaming}
        markdown={part.markdown}
        proseSize="normal"
      />
    );
  }

  return (
    <>
      {part.prose.length === 0 ? null : (
        <AgentReferenceMarkdown
          isStreaming={props.isStreaming}
          markdown={part.prose}
          proseSize="normal"
        />
      )}
      <NextStepsActionGroup
        blockId={part.id}
        options={part.options}
        complete={part.complete}
        locked={props.locked}
        actionHandler={props.nextStepActions}
        onLock={props.onLock}
      />
    </>
  );
}
