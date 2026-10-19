import type { ReactNode } from "react";
import { ChevronDown, Users } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ToolbarPillButton } from "@/components/home/toolbar/toolbar-buttons";
import { teamFirstChatLine } from "@/components/home/composer/landing-owner-model";
import { useLandingOwner } from "@/hooks/home/use-landing-owner";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  landingOwnerDraftKey,
  useLandingOwnerStore,
} from "@/stores/home/landing-owner-store";

const PERSONAL_VALUE = "personal";

/**
 * The Belongs to chip on a new-task landing draft, listing Personal and
 * each of the person's teams by slug. Hidden for someone in no team.
 */
export function LandingOwnerChip(props: {
  readonly draftId: string | null;
  readonly resolvedHostId: string | null;
}): ReactNode {
  const teams = useAuthStore((s) => s.shareableTeams);
  const owner = useLandingOwner(props.draftId, props.resolvedHostId);
  const setChoice = useLandingOwnerStore((s) => s.setChoice);
  if (teams.length === 0) return null;
  const draftKey = landingOwnerDraftKey(props.draftId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ToolbarPillButton
          aria-label="Belongs to"
          data-testid="landing-owner-chip"
          className="max-w-[min(32cqw,12rem)] min-w-0"
        >
          <Users className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">
            {owner === null ? "Personal" : owner.slug}
          </span>
          <ChevronDown
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
        </ToolbarPillButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={owner === null ? PERSONAL_VALUE : owner.teamId}
          onValueChange={(next) => {
            setChoice(
              draftKey,
              next === PERSONAL_VALUE
                ? { kind: "personal" }
                : { kind: "team", teamId: next },
            );
          }}
        >
          <DropdownMenuRadioItem
            value={PERSONAL_VALUE}
            data-testid="landing-owner-option-personal"
          >
            Personal
          </DropdownMenuRadioItem>
          {teams.map((team) => (
            <DropdownMenuRadioItem
              key={team.teamId}
              value={team.teamId}
              data-testid={`landing-owner-option-${team.teamId}`}
            >
              {team.slug}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The first-chat line under a team pick. */
export function LandingTeamChatLine(props: {
  readonly draftId: string | null;
  readonly resolvedHostId: string | null;
}): ReactNode {
  const owner = useLandingOwner(props.draftId, props.resolvedHostId);
  if (owner === null) return null;
  return (
    <p
      className="m-0 px-1 text-ui-xs text-muted-foreground"
      data-testid="landing-team-first-chat-line"
    >
      {teamFirstChatLine(owner.slug)}
    </p>
  );
}
