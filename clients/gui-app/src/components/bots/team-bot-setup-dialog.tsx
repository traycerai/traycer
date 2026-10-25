import { useRef, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import type { BotOnboardingReadResponse } from "@traycer/protocol/host/bot/onboarding-schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  BotsStep,
  GithubStep,
  OnboardingCreateControls,
  OnboardingOpenButton,
} from "@/components/home/bots/bot-onboarding-card";
import { CreateBotForm } from "@/components/home/bots/create-bot-form";
import { useTeamOnboardingFlow } from "@/components/home/bots/use-team-onboarding-flow";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useTeamOnboardingGate } from "@/hooks/bots/use-team-onboarding-gate";
import type { HostEnvironmentBindings } from "@/hooks/bots/use-host-environment-bindings-query";

/** One team's section, as the setup reads it. */
export interface TeamBotSetupTarget {
  readonly environmentId: string;
  readonly teamName: string;
  readonly botCount: number;
  /** The control that opened the setup; focus returns to it on dismissal. */
  readonly opener: HTMLElement | null;
}

/**
 * Where a team's bots are set up, behind its section's + in the channel
 * sidebar (Tracy Bots T59). While the team's onboarding is open it walks it:
 * GitHub, then the bots the team starts with, then Create, with a back arrow
 * between the two. Otherwise it is the create form for one more bot. On
 * success the new channel opens and the dialog closes, leaving focus to the
 * channel; dismissed, it returns focus to its opener while that is still on
 * the page.
 *
 * The body scrolls between the header and footer bands, so a long catalog or
 * form stays inside the viewport.
 */
export function TeamBotSetupDialog(props: {
  readonly team: TeamBotSetupTarget | null;
  readonly connectableHostIds: ReadonlyArray<string>;
  readonly environmentBindings: HostEnvironmentBindings;
  readonly onClose: () => void;
}): ReactNode {
  const { team, onClose } = props;
  // Escape, Close, an outside press and the form's Cancel dismiss; a success
  // closes through `onClose` directly and keeps the destination's focus.
  const dismissedRef = useRef(false);
  const dismiss = (): void => {
    dismissedRef.current = true;
    onClose();
  };
  return (
    <Dialog
      open={team !== null}
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      {team === null ? null : (
        <DialogContent
          layout="banded"
          className="grid max-h-[min(86dvh,calc(100dvh-2rem))] w-full min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden"
          style={{ maxWidth: "min(92vw, 32rem)" }}
          data-testid="team-bot-setup-dialog"
          onOpenAutoFocus={() => {
            dismissedRef.current = false;
          }}
          onCloseAutoFocus={(event) => {
            // Opened through state, not a `DialogTrigger`: the primitive has
            // no trigger to return focus to.
            const opener = team.opener;
            if (!dismissedRef.current || opener === null) return;
            if (!opener.isConnected) return;
            event.preventDefault();
            opener.focus();
          }}
        >
          <TeamBotSetup
            team={team}
            connectableHostIds={props.connectableHostIds}
            environmentBindings={props.environmentBindings}
            onOpened={onClose}
            onCancel={dismiss}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}

function TeamBotSetup(props: {
  readonly team: TeamBotSetupTarget;
  readonly connectableHostIds: ReadonlyArray<string>;
  readonly environmentBindings: HostEnvironmentBindings;
  /** Runs once the setup has opened a channel. */
  readonly onOpened: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const { team, connectableHostIds, environmentBindings, onOpened } = props;
  const { gate, onboarding } = useTeamOnboardingGate({
    client: useTabHostClient(),
    hostId: useTabHostId(),
    environmentId: team.environmentId,
    isTeam: true,
    botCount: team.botCount,
  });
  const data = onboarding.data;
  if (gate === "pending" || (gate === "locked" && data === undefined)) {
    return (
      <>
        <SetupHeader title={`Set up ${team.teamName}'s bots`} back={null}>
          Loading your team's setup.
        </SetupHeader>
        <div className="flex justify-center px-5 py-6">
          <AgentSpinningDots
            className={undefined}
            testId="team-bot-setup-loading"
            variant={undefined}
          />
        </div>
      </>
    );
  }
  if (gate === "none" || data === undefined) {
    return (
      <>
        <SetupHeader title={`Add a bot to ${team.teamName}`} back={null}>
          The bot gets its own channel.
        </SetupHeader>
        <div className="flex min-h-0 min-w-0 flex-col overflow-y-auto px-5 py-4">
          <CreateBotForm
            environmentId={team.environmentId}
            environmentLabel={team.teamName}
            connectableHostIds={connectableHostIds}
            environmentBindings={environmentBindings}
            onCreated={onOpened}
            onCancel={props.onCancel}
          />
        </div>
      </>
    );
  }
  return (
    <TeamOnboardingSetup
      team={team}
      data={data}
      connectableHostIds={connectableHostIds}
      environmentBindings={environmentBindings}
      onOpened={onOpened}
    />
  );
}

type OnboardingStep = "github" | "bots";

function TeamOnboardingSetup(props: {
  readonly team: TeamBotSetupTarget;
  readonly data: BotOnboardingReadResponse;
  readonly connectableHostIds: ReadonlyArray<string>;
  readonly environmentBindings: HostEnvironmentBindings;
  readonly onOpened: () => void;
}): ReactNode {
  const { team, data, environmentBindings } = props;
  // A connected team starts at its bots; GitHub stays one step back.
  const [step, setStep] = useState<OnboardingStep>(
    data.unlocked ? "bots" : "github",
  );
  const flow = useTeamOnboardingFlow({
    environmentId: team.environmentId,
    connectableHostIds: props.connectableHostIds,
    environmentBindings,
    data,
    onOpened: props.onOpened,
  });
  const title = `Set up ${team.teamName}'s bots`;
  if (step === "github") {
    return (
      <>
        <SetupHeader title={title} back={null}>
          Step 1 of 2: connect GitHub.
        </SetupHeader>
        <div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto px-5 py-4">
          <GithubStep github={data.github} teamName={team.teamName} />
        </div>
        <DialogFooter>
          <Button
            type="button"
            size="sm"
            data-testid="team-bot-setup-next"
            onClick={() => setStep("bots")}
          >
            Next
          </Button>
        </DialogFooter>
      </>
    );
  }
  return (
    <>
      <SetupHeader title={title} back={() => setStep("github")}>
        Step 2 of 2: choose the bots.
      </SetupHeader>
      <div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto px-5 py-4">
        <BotsStep
          catalog={data.catalog}
          chosen={flow.chosen}
          pendingAreas={flow.pendingAreas}
          disabled={flow.completing}
          onToggle={flow.toggle}
        />
        {data.unlocked ? null : (
          <p
            role="status"
            data-testid="team-bot-setup-needs-github"
            className="text-ui-xs text-muted-foreground"
          >
            Connect GitHub to create the bots.
          </p>
        )}
        <OnboardingCreateControls
          flow={flow}
          unlocked={data.unlocked}
          teamName={team.teamName}
          environmentBindings={environmentBindings}
        />
      </div>
      <DialogFooter>
        <OnboardingOpenButton flow={flow} label="Create" />
      </DialogFooter>
    </>
  );
}

function SetupHeader(props: {
  readonly title: string;
  /** Goes one step back; `null` on a first step. */
  readonly back: (() => void) | null;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <DialogHeader>
      <div className="flex min-w-0 items-center gap-2">
        {props.back === null ? null : (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Back"
            data-testid="team-bot-setup-back"
            onClick={props.back}
          >
            <ArrowLeft aria-hidden className="size-4" />
          </Button>
        )}
        <DialogTitle className="min-w-0 wrap-anywhere">
          {props.title}
        </DialogTitle>
      </div>
      <DialogDescription>{props.children}</DialogDescription>
    </DialogHeader>
  );
}
