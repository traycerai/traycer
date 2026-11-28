import { useHostCredentialStatus } from "@/hooks/host/use-host-credential-status";
import { useHostOwnership } from "@/hooks/auth/use-host-ownership";
/** Docs: see ../SETTINGS.md (Host Overview's settings source). */
import { useCallback, useState, type ReactNode } from "react";
import {
  HostOverviewSettingsCardSlot,
  type OwnershipReceipt,
  type StartedGive,
} from "@/components/settings/panels/host-overview-settings-card";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { HostOwnerPrincipal } from "@traycer/protocol/host/host-status";

/**
 * One Environment row, read through the host named by the page.
 *
 * A failed read shows nothing. The row does not guess Personal or a team
 * from sandbox ownership: that binding is not this read.
 */
export function HostEnvironmentSection(props: {
  readonly scope: HostScope;
  readonly hostName: string;
  readonly shownFromRow: boolean;
}): ReactNode {
  const { scope } = props;
  const credentialStatus = useHostCredentialStatus(scope.hostId);
  const local = scope.host?.isLocalMachine ?? false;
  const { readOwner, receipt, onReturn } = useOwnershipReceipt(
    scope.hostId,
    local,
  );
  const owner = local ? readOwner : (scope.host?.item?.owner ?? null);
  return (
    <>
      {credentialStatus === "team-unavailable" && owner?.kind !== "user" ? (
        <p role="status" className="text-ui-sm text-muted-foreground">
          This computer can't work for the team right now.
        </p>
      ) : null}
      <HostOverviewSettingsCardSlot
        client={scope.client}
        hostId={scope.hostId}
        hostName={props.hostName}
        owner={owner}
        isLocalMachine={scope.host?.isLocalMachine ?? false}
        usable={isHostScopeUsable(scope.status) && scope.client !== null}
        receipt={receipt}
        onReturn={onReturn}
        shownFromRow={props.shownFromRow}
      />
    </>
  );
}

/**
 * The give and claim receipt, held here because this section stays mounted
 * while the owner change restarts the computer and the card is away.
 */
function useOwnershipReceipt(
  hostId: string | null,
  local: boolean,
): {
  /** This section's own owner read; null while unread or not read. */
  readonly readOwner: HostOwnerPrincipal | null;
  readonly receipt: OwnershipReceipt;
  readonly onReturn: () => void;
} {
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  // The card's own key: a receipt belongs to one computer and one sign-in.
  const holder = JSON.stringify([hostId, userId]);
  const [shown, setShown] = useState<HeldLine | null>(null);
  const [started, setStarted] = useState<HeldGive | null>(null);
  const startedGive = started?.holder === holder ? started : null;
  const giveStarted = startedGive !== null;
  const ownership = useHostOwnership(hostId, local || giveStarted);
  // A give whose dialog went with the card ends here, once an owner read
  // answered after its start names its team.
  if (
    startedGive !== null &&
    ownership.data?.owner.kind === "team" &&
    ownership.data.owner.id === startedGive.teamId &&
    ownership.dataUpdatedAt > startedGive.startedAt
  ) {
    setShown({ holder, line: startedGive.line });
    setStarted(null);
  }
  const { refetch } = ownership;
  // When the host drops first, the dialog's ownership invalidation dies with it.
  const onReturn = useCallback(() => {
    if (giveStarted) void refetch();
  }, [giveStarted, refetch]);
  return {
    readOwner: ownership.data?.owner ?? null,
    receipt: {
      line: shown?.holder === holder ? shown.line : null,
      show: (line) => {
        setShown({ holder, line });
        setStarted(null);
      },
      giveStarted: (give) =>
        setStarted({ ...give, holder, startedAt: Date.now() }),
    },
    onReturn,
  };
}

interface HeldLine {
  readonly holder: string;
  readonly line: string;
}

interface HeldGive extends StartedGive, HeldLine {
  readonly startedAt: number;
}
