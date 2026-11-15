import {
  claimedComputerDetail,
  claimedComputerTitle,
} from "@/hooks/teams/claimed-computer-notice-model";
import { DOOR_STATE_TITLES } from "@/lib/host/door-state-titles";
import type { DoorStateCoverVariant } from "@/lib/host/window-narration";

export interface DoorCoverCopy {
  readonly title: string;
  readonly description: string;
}

/**
 * Board C1's words for each door cover: the same title and line on the window
 * cover and on a tile whose computer is not the window's own.
 */
const DOOR_COVER_COPY: Readonly<
  Record<Exclude<DoorStateCoverVariant["kind"], "host-claimed">, DoorCoverCopy>
> = {
  "token-unavailable": {
    title: DOOR_STATE_TITLES["token-unavailable"],
    description: "We'll try again. Your draft is saved.",
  },
  "keys-unavailable": {
    title: "This computer needs to connect once before it can verify access",
    description: "Check its connection, then retry.",
  },
  "clock-skew": {
    title: "This computer's date or time appears incorrect",
    description: "Enable automatic date and time on that computer, then retry.",
  },
  "token-expired": {
    title: DOOR_STATE_TITLES["token-expired"],
    description:
      "Connect to the internet and retry. Work already started remains on this computer.",
  },
  "enrolment-broken": {
    title: "This computer's connection to the team needs repair",
    description:
      "Ask a team administrator to restore it. Work is still stored here.",
  },
  "membership-removed": {
    title: "You no longer have access to this team's computer",
    description:
      "Ask a team administrator if this is unexpected. Work you started continues for the team.",
  },
  "team-membership-required": {
    title: "This computer belongs to a team",
    description:
      "This account is not a member. Switch accounts to use Traycer here.",
  },
  "not-admitted": {
    title: "This account cannot access this computer",
    description: "Switch accounts to use it.",
  },
};

export function doorCoverCopy(variant: DoorStateCoverVariant): DoorCoverCopy {
  // A claimed computer's lines are the claimed notice's own, with the names
  // authn's claim gives.
  if (variant.kind === "host-claimed") {
    return {
      title: claimedComputerTitle(variant.claimantName),
      description: claimedComputerDetail(variant.teamName),
    };
  }
  return DOOR_COVER_COPY[variant.kind];
}
