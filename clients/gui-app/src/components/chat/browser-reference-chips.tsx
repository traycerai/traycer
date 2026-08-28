import type { BrowserAnnotationRecord } from "@traycer/protocol/persistence/epic/schemas";
import { BrowserAnnotationCard } from "@/components/chat/composer/browser-annotation-card";
import { useChatImageFetcher } from "@/lib/attachments/use-chat-image-fetcher";

export function BrowserReferenceChips(props: {
  readonly annotations: ReadonlyArray<BrowserAnnotationRecord>;
}) {
  // Every other message renders this unconditionally with an empty array, so
  // the common case must stay cheap - only a message with annotations
  // attached does real work here.
  if (props.annotations.length === 0) return null;
  return (
    <div className="mb-2 flex w-full min-w-0 flex-col gap-1.5">
      <SentAnnotationCards annotations={props.annotations} />
    </div>
  );
}

function noSessionObjectUrl(_hash: string): string | null {
  return null;
}

function SentAnnotationCards(props: {
  readonly annotations: ReadonlyArray<BrowserAnnotationRecord>;
}) {
  const fetcher = useChatImageFetcher();
  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5">
      {props.annotations.map((annotation) => (
        <BrowserAnnotationCard
          key={annotation.annotationId}
          record={annotation}
          onRemove={null}
          imageFetcher={fetcher}
          sessionObjectUrl={noSessionObjectUrl}
        />
      ))}
    </div>
  );
}
