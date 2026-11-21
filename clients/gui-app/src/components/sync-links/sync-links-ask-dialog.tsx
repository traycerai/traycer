import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type {
  SyncLinksFolder,
  SyncLinksPeer,
} from "@traycer/protocol/host/sync-links-schemas";
import {
  ASK_DETAILS,
  ASK_STOP,
  askDialogTitle,
  askFolderRowText,
  askMoveDetail,
  askMoveLabel,
  askStopDetail,
  askStopDetailPeerNeedsUpdate,
  askStopDetailPeersNeedUpdate,
  peerNeedsUpdateText,
} from "@/components/sync-links/sync-links-copy";
import { ConfigurationWriteFeedback } from "@/components/settings/environment/configuration-write-feedback";
import type { ConfigurationWriteIssue } from "@/components/settings/environment/configuration-write-issue";
import { namedPeers, peerName } from "@/components/sync-links/sync-links-peers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { providerDisplayName } from "@/lib/provider-ordering";

/**
 * The Stop line: board 2's while every linked computer is updated; board 8's
 * when one is still on 1.5.4 (this computer gives up its copy, I6); board
 * 11's, held, when two or more of one account's computers are.
 */
function stopDetail(
  folders: readonly SyncLinksFolder[],
  names: readonly string[],
): string {
  const namesNeedingUpdate = namedPeers(folders)
    .filter((peer) => peer.needsUpdate)
    .map((peer) => peer.name);
  if (namesNeedingUpdate.length === 0) return askStopDetail(names);
  const severalOnOneAccount = folders.some(
    (folder) =>
      folder.peers.filter((peer) => peer.version === "needs-update").length > 1,
  );
  return severalOnOneAccount
    ? askStopDetailPeersNeedUpdate(namesNeedingUpdate)
    : askStopDetailPeerNeedsUpdate(namesNeedingUpdate);
}

function folderPeerNames(peers: readonly SyncLinksPeer[]): string {
  return peers.map(peerName).join(", ");
}

/**
 * The ask's modal (boards 2, 3, 7, 8): the linked accounts, the reasons
 * folded under Details, and the two answers. A team computer is offered only
 * Stop syncing (I9).
 */
export function SyncLinksAskDialog(props: {
  readonly folders: readonly SyncLinksFolder[];
  readonly teamComputer: boolean;
  readonly stopPending: boolean;
  /** Why the last Stop did not land, shown until the next opening. */
  readonly stopIssue: ConfigurationWriteIssue;
  readonly onStop: () => void;
  readonly onMove: () => void;
  readonly onClose: () => void;
}): ReactNode {
  const peers = namedPeers(props.folders);
  const names = peers.map((peer) => peer.name);
  const needingUpdate = peers.filter((peer) => peer.needsUpdate);
  const showPeerChips = peers.length > 1;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        data-testid="sync-links-ask-dialog"
        showCloseButton={false}
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>{askDialogTitle(names)}</DialogTitle>
        </DialogHeader>
        <ul className="flex flex-col gap-1.5">
          {props.folders.map((folder) => (
            <li
              key={`${folder.providerId}:${folder.profileId}`}
              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-sm"
            >
              <span className="min-w-0 truncate">
                {askFolderRowText(
                  providerDisplayName(folder.providerId),
                  folder.label,
                )}
              </span>
              {showPeerChips ? (
                <Badge variant="outline" size="xs" className="shrink-0">
                  {folderPeerNames(folder.peers)}
                </Badge>
              ) : null}
            </li>
          ))}
        </ul>
        {needingUpdate.map((peer) => (
          <p key={peer.hostId} className="text-ui-sm text-muted-foreground">
            {peerNeedsUpdateText(peer.name)}
          </p>
        ))}
        <Collapsible>
          <CollapsibleTrigger
            variant="quiet"
            className="group flex items-center"
          >
            <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
            {ASK_DETAILS}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-1 flex list-disc flex-col gap-1 pl-5 text-ui-sm text-muted-foreground">
              {props.teamComputer ? null : <li>{askMoveDetail(names)}</li>}
              <li>{stopDetail(props.folders, names)}</li>
            </ul>
          </CollapsibleContent>
        </Collapsible>
        <ConfigurationWriteFeedback issue={props.stopIssue} />
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={props.stopPending}
            onClick={props.onStop}
          >
            {ASK_STOP}
          </Button>
          {props.teamComputer ? null : (
            <Button
              type="button"
              disabled={props.stopPending}
              onClick={props.onMove}
            >
              {askMoveLabel(peers.length)}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
