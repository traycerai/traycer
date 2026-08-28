import { useMemo } from "react";
import type {
  BrowserAnnotationRecord,
  BrowserContextAttachmentRecord,
} from "@traycer/protocol/persistence/epic/schemas";
import type { BrowserTabInfo } from "@traycer/protocol/host/browser/contracts";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useMaybeBrowserSessionsContext } from "@/components/epic-canvas/renderers/browser-sessions-context";
import { BrowserFavicon } from "@/components/epic-canvas/browser-favicon";
import { BrowserAnnotationCard } from "@/components/chat/composer/browser-annotation-card";
import { useChatImageFetcher } from "@/lib/attachments/use-chat-image-fetcher";
import {
  browserTabFaviconUrl,
  resolveTabTitle,
} from "@/lib/browser-view/browser-tab-display";

export function BrowserReferenceChips(props: {
  readonly references: ReadonlyArray<BrowserContextAttachmentRecord>;
  readonly annotations: ReadonlyArray<BrowserAnnotationRecord>;
}) {
  // Every other message renders this unconditionally with empty arrays, so
  // the common case must not require BrowserSessionsProvider to be mounted -
  // only messages that actually reference a browser tab need the live lookup.
  if (props.references.length === 0 && props.annotations.length === 0) {
    return null;
  }
  return (
    <div className="mb-2 flex w-full min-w-0 flex-col gap-1.5">
      {props.annotations.length > 0 ? (
        <SentAnnotationCards annotations={props.annotations} />
      ) : null}
      {props.references.length > 0 ? (
        <BrowserReferenceChipsLive references={props.references} />
      ) : null}
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

function BrowserReferenceChipsLive(props: {
  readonly references: ReadonlyArray<BrowserContextAttachmentRecord>;
}) {
  const sessions = useMaybeBrowserSessionsContext();
  const tabByReferenceKey = useMemo(() => {
    const map = new Map<string, BrowserTabInfo>();
    sessions?.items.forEach((session) => {
      session.tabs.forEach((tab) => {
        map.set(`${session.sessionId}:${tab.tabId}`, tab);
      });
    });
    return map;
  }, [sessions?.items]);

  return (
    <div className="flex max-w-full flex-wrap justify-start gap-1.5">
      {props.references.map((reference) => {
        const tab = tabByReferenceKey.get(
          `${reference.sessionId}:${reference.tabId}`,
        );
        const title = tab === undefined ? "Browser" : resolveTabTitle(tab);
        const favicon =
          tab === undefined ? null : browserTabFaviconUrl(tab.url);
        return (
          <TooltipWrapper
            key={`${reference.kind}:${reference.sessionId}:${reference.tabId}`}
            label={`Browser session ${reference.sessionId}, tab ${reference.tabId}`}
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/70 bg-background/70 px-2 py-1 text-ui-xs text-muted-foreground">
              <BrowserFavicon
                faviconUrl={favicon}
                isolated={false}
                className="size-3.5"
              />
              <span className="truncate">{title}</span>
            </span>
          </TooltipWrapper>
        );
      })}
    </div>
  );
}
