import { useCallback, useMemo, useState, type ComponentType } from "react";
import {
  parseTraycerNextStepsMarkdown,
  type TraycerNextStepsPart,
} from "@/markdown/traycer-next-steps";
import { withMemberAdded } from "@/lib/immutable-set";
import type { AssistantMarkdownImageContext } from "@/stores/composer/chat-store";
import { AgentReferenceMarkdown } from "./agent-reference-markdown";
import {
  AssistantMarkdownImageNode,
  AssistantMarkdownImageProvider,
} from "./assistant-markdown-image";
import {
  NextStepsActionGroup,
  type NextStepActionHandler,
} from "./next-steps-action-group";

interface TextSegmentProps {
  findUnitId: string | null;
  markdown: string;
  isStreaming: boolean;
  nextStepActions: NextStepActionHandler | null;
  imageContext?: AssistantMarkdownImageContext;
}

const ASSISTANT_IMAGE_COMPONENTS: Record<
  string,
  ComponentType<Record<string, unknown>>
> = {
  img: AssistantMarkdownImageNode as ComponentType<Record<string, unknown>>,
};

function nextStepOptionLockKey(blockId: string, optionId: string): string {
  return `${blockId}:${optionId}`;
}

export function TextSegment(props: TextSegmentProps) {
  const imageContext = props.imageContext ?? null;
  const markdownComponents =
    imageContext === null ? null : ASSISTANT_IMAGE_COMPONENTS;
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
    <AssistantMarkdownImageProvider context={imageContext}>
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
            markdownComponents={markdownComponents}
            imageRendering={imageContext === null ? "standard" : "assistant"}
          />
        ))}
      </div>
    </AssistantMarkdownImageProvider>
  );
}

interface TextSegmentPartProps {
  readonly part: TraycerNextStepsPart;
  readonly lockedOptionKeys: ReadonlySet<string>;
  readonly isStreaming: boolean;
  readonly nextStepActions: NextStepActionHandler | null;
  readonly onLockOption: (blockId: string, optionId: string) => void;
  readonly markdownComponents: Record<
    string,
    ComponentType<Record<string, unknown>>
  > | null;
  readonly imageRendering: "assistant" | "standard";
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
        components={props.markdownComponents}
        imageRendering={props.imageRendering}
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

  // Own the gap above next-steps. Body markdown and next-steps prose are
  // separate `.md-prose` trees, and the Tailmark first/last margin zeroing in
  // `index.css` collapses the trailing margin of the body (often a `---` rule)
  // plus the leading margin of this prose - without this wrapper they stick.
  // `first:mt-0` keeps a message that is only next-steps flush at the top.
  return (
    <div className="mt-4 first:mt-0">
      {part.prose.length === 0 ? null : (
        <AgentReferenceMarkdown
          isStreaming={props.isStreaming}
          markdown={part.prose}
          proseSize="normal"
          quotable
          components={props.markdownComponents}
          imageRendering={props.imageRendering}
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
    </div>
  );
}
