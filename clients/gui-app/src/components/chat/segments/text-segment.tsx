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

function nextStepOptionLockKey(blockId: string, optionId: string): string {
  return `${blockId}:${optionId}`;
}

export function TextSegment(props: TextSegmentProps) {
  const parts = useMemo(
    () => parseTraycerNextStepsMarkdown(props.markdown, props.isStreaming),
    [props.isStreaming, props.markdown],
  );
  const [lockedOptionKeys, setLockedOptionKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const lockOption = useCallback((blockId: string, optionId: string) => {
    setLockedOptionKeys((current) =>
      withMemberAdded(current, nextStepOptionLockKey(blockId, optionId)),
    );
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
          lockedOptionKeys={lockedOptionKeys}
          isStreaming={props.isStreaming}
          nextStepActions={props.nextStepActions}
          onLockOption={lockOption}
        />
      ))}
    </div>
  );
}

interface TextSegmentPartProps {
  readonly part: TraycerNextStepsPart;
  readonly lockedOptionKeys: ReadonlySet<string>;
  readonly isStreaming: boolean;
  readonly nextStepActions: NextStepActionHandler | null;
  readonly onLockOption: (blockId: string, optionId: string) => void;
}

function TextSegmentPart(props: TextSegmentPartProps) {
  const { part } = props;
  if (part.kind === "markdown") {
    return (
      <AgentReferenceMarkdown
        isStreaming={props.isStreaming}
        markdown={part.markdown}
        proseSize="normal"
        quotable
      />
    );
  }

  const lockedOptionIds = new Set(
    part.options
      .filter((option) =>
        props.lockedOptionKeys.has(nextStepOptionLockKey(part.id, option.id)),
      )
      .map((option) => option.id),
  );

  return (
    <>
      {part.prose.length === 0 ? null : (
        <AgentReferenceMarkdown
          isStreaming={props.isStreaming}
          markdown={part.prose}
          proseSize="normal"
          quotable
        />
      )}
      <NextStepsActionGroup
        blockId={part.id}
        options={part.options}
        complete={part.complete}
        lockedOptionIds={lockedOptionIds}
        actionHandler={props.nextStepActions}
        onLockOption={props.onLockOption}
      />
    </>
  );
}
