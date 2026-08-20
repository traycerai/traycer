import type { ReactNode } from "react";
import type { DraftAuthorityControl } from "@/hooks/drafts/use-draft-authority";
import { DraftAuthorityBanner } from "@/components/drafts/draft-authority-banner";
import { ChatComposerBannerPortal } from "./chat-composer-banner-portal";

export function ChatComposerDraftAuthorityBanner(props: {
  readonly authority: DraftAuthorityControl;
}): ReactNode {
  if (!props.authority.readOnly) return null;
  return (
    <ChatComposerBannerPortal>
      <div className="pointer-events-none px-4">
        <div className="pointer-events-auto mx-auto w-full max-w-3xl bg-canvas pt-4">
          <DraftAuthorityBanner
            ownerLabel={props.authority.ownerLabel}
            claiming={props.authority.claiming}
            claimError={props.authority.claimError}
            publicationLabel={props.authority.publicationLabel}
            onClaim={() => {
              void props.authority.claim();
            }}
          />
        </div>
      </div>
    </ChatComposerBannerPortal>
  );
}
