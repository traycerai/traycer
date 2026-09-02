import type { MouseEvent, ReactNode } from "react";
import { Copy, Download, ExternalLink, Share2 } from "lucide-react";

import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import type { ImageAction } from "@/lib/images/perform-image-action";
import type { LinkClickEvent } from "@/lib/links/open-link";

/** Remote images swap Download for Open-in-browser; local blobs pass null. */
export interface ImageRemoteOpen {
  readonly onOpen: (event: LinkClickEvent) => void;
}

export function ImageActions(props: {
  readonly pendingAction: ImageAction | null;
  readonly canCopy: boolean;
  /**
   * Whether this shell hands files to an OS chooser, in which case sharing and
   * downloading are two different acts and both are offered. Ignored beside a
   * remote image, whose control is Open-in-browser rather than any save.
   */
  readonly canShare: boolean;
  /**
   * Whether a Download can be honoured at all. False on a shell that hands
   * everything to a chooser and owns no direct write (Android 10), where the
   * control would route back into the share sheet it is meant to be distinct
   * from.
   */
  readonly canDownload: boolean;
  readonly remote: ImageRemoteOpen | null;
  readonly onCopy: () => void;
  readonly onShare: () => void;
  readonly onDownload: () => void;
}): ReactNode {
  // The trailing slot: Open-in-browser for a remote image (no save capability
  // gates it), Download for a local one - and nothing at all where the shell
  // is chooser-only, since a Download there would route back into the share
  // sheet it is meant to be distinct from.
  let saveOrOpen: ReactNode = null;
  if (props.remote !== null) {
    saveOrOpen = (
      <ImageActionButton
        label="Open in browser"
        disabled={props.pendingAction !== null}
        pending={false}
        onClick={props.remote.onOpen}
        icon={<ExternalLink className="size-3.5" aria-hidden />}
      />
    );
  } else if (props.canDownload) {
    saveOrOpen = (
      <ImageActionButton
        label="Download image"
        disabled={props.pendingAction !== null}
        pending={props.pendingAction === "download"}
        onClick={props.onDownload}
        icon={<Download className="size-3.5" aria-hidden />}
      />
    );
  }
  return (
    <div className="flex items-center gap-1 rounded-md border border-white/15 bg-black/65 p-1 text-white shadow-sm backdrop-blur-sm @max-[8rem]:gap-0 @max-[8rem]:border-0 @max-[8rem]:p-0">
      {props.canCopy ? (
        <ImageActionButton
          label="Copy image"
          disabled={props.pendingAction !== null}
          pending={props.pendingAction === "copy"}
          onClick={props.onCopy}
          icon={<Copy className="size-3.5" aria-hidden />}
        />
      ) : null}
      {props.canShare && props.remote === null ? (
        <ImageActionButton
          label="Share image"
          disabled={props.pendingAction !== null}
          pending={props.pendingAction === "share"}
          onClick={props.onShare}
          icon={<Share2 className="size-3.5" aria-hidden />}
        />
      ) : null}
      {saveOrOpen}
    </div>
  );
}

function ImageActionButton(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly icon: ReactNode;
}): ReactNode {
  return (
    <TooltipWrapper
      label={props.label}
      side="top"
      sideOffset={6}
      align="center"
    >
      <button
        type="button"
        disabled={props.disabled}
        onClick={props.onClick}
        className="flex size-7 items-center justify-center rounded-sm text-white/85 outline-none transition-colors hover:bg-white/15 hover:text-white focus-visible:ring-1 focus-visible:ring-white disabled:opacity-50"
        aria-label={props.label}
      >
        {props.pending ? (
          <AgentSpinningDots
            className="text-current"
            testId="image-action-spinner"
            variant={undefined}
          />
        ) : (
          props.icon
        )}
      </button>
    </TooltipWrapper>
  );
}
