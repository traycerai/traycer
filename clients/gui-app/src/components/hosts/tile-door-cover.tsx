import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useHostBinding } from "@/lib/host";
import { doorCoverCopy } from "@/lib/host/door-cover-copy";
import { retryHostDoor } from "@/lib/host/host-door-retry";
import {
  offersDoorRetry,
  type DoorStateCoverVariant,
} from "@/lib/host/window-narration";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useSignOutConfirmStore } from "@/stores/auth/sign-out-confirm-store";

/**
 * Board C1's column (b): the tile's body is the state's title and line, with
 * Retry where the board draws it and Switch account for a non-member. Drawn
 * over the body, which stays mounted, so a draft in it is kept.
 */
export function TileDoorCoverLayer(props: {
  readonly cover: DoorStateCoverVariant;
}): ReactNode {
  const copy = doorCoverCopy(props.cover);
  return (
    <div
      data-testid="tile-door-cover"
      data-kind={props.cover.kind}
      className="absolute inset-0 z-10 flex items-center justify-center bg-background p-6"
    >
      <div
        role="status"
        className="flex max-w-sm flex-col items-center gap-2 text-center"
      >
        <p className="text-ui-sm font-medium text-foreground">{copy.title}</p>
        <p className="text-ui-xs text-muted-foreground">{copy.description}</p>
        <TileDoorCoverAction cover={props.cover} />
      </div>
    </div>
  );
}

function TileDoorCoverAction(props: {
  readonly cover: DoorStateCoverVariant;
}): ReactNode {
  const { hostTokens } = useRunnerHost();
  const hostBinding = useHostBinding();
  const queryClient = useQueryClient();
  const { cover } = props;
  if (offersDoorRetry(cover)) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="mt-2"
        onClick={() => {
          void retryHostDoor(cover.hostId, hostTokens);
        }}
      >
        Retry
      </Button>
    );
  }
  if (cover.kind !== "team-membership-required" || hostBinding === null) {
    return null;
  }
  return (
    <Button
      type="button"
      size="sm"
      variant="default"
      className="mt-2"
      onClick={() => {
        void useSignOutConfirmStore
          .getState()
          .signOut(queryClient, hostBinding.auth);
      }}
    >
      Switch account
    </Button>
  );
}
