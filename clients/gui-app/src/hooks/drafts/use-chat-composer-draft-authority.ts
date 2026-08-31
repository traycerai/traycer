import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import {
  useDraftAuthorityControl,
  type DraftAuthorityControl,
} from "./use-draft-authority";

export function useChatComposerDraftAuthority(args: {
  readonly chatId: string;
  readonly tabHostId: string;
  readonly client: HostClient<HostRpcRegistry> | null;
}): DraftAuthorityControl {
  const draftId = useComposerDraftStore(
    (state) => state.drafts[args.chatId]?.draftId ?? null,
  );
  const ownerHostId = useComposerDraftStore(
    (state) => state.drafts[args.chatId]?.ownerHostId ?? null,
  );
  const origin = useComposerDraftStore(
    (state) => state.drafts[args.chatId]?.origin ?? null,
  );
  const publication = useComposerDraftStore(
    (state) => state.drafts[args.chatId]?.publication ?? null,
  );
  return useDraftAuthorityControl({
    draftId,
    ownerHostId,
    origin,
    tabHostId: args.tabHostId,
    client: args.client,
    publication,
  });
}
