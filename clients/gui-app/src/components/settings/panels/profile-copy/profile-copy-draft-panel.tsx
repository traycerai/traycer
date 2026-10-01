import { useEffect, useId, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { Switch } from "@/components/ui/switch";
import { observeProfileCopyOutcome } from "@/hooks/providers/profile-copy/profile-copy-observations";
import { useProfileCopyDraftStatusQuery } from "@/hooks/providers/profile-copy/use-profile-copy-queries";
import type {
  ProfileCopyAttempt,
  ProfileCopyKnownRoute,
  ProfileCopyOutcome,
} from "@/lib/profile-copy/profile-copy-model";
import {
  presentProfileCopyDirectBlock,
  presentProfileCopyOutcome,
  profileCopyDirectBlockCopy,
  profileCopyDraftActions,
  profileCopyExistingProfileFacts,
  profileCopyPreferenceEditable,
  profileCopyReasonCopy,
  profileCopyStartRefusalCopy,
  type ProfileCopyDirectBlock,
  type ProfileCopyDraftAction,
  type ProfileCopyDraftActions,
  type ProfileCopyNames,
  type ProfileCopyOutcomeContext,
  type ProfileCopyOutcomePresentation,
} from "@/lib/profile-copy/profile-copy-presentation";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";
import { ProfileCopyImportLoginStep } from "./profile-copy-import-login-step";
import { ProfileCopyBadge } from "./profile-copy-badge";
import {
  profileCopyRequestErrorText,
  useProfileCopyExistingProfile,
  useProfileCopyHosts,
} from "./profile-copy-shared";
import {
  isProfileCopySignInAction,
  useProfileCopyDraftController,
  type DraftAnswerNotice,
  type PendingConfirm,
  type ProfileCopyDraftController,
} from "./use-profile-copy-draft-controller";
import {
  useProfileImportLoginFlow,
  type ProfileImportLoginNotice,
} from "./use-profile-import-login-flow";

/**
 * The newer of two views of one attempt. The source's `status` carries the
 * destination's outcome as it last heard it; the destination's own
 * `draftStatus` is usually newer, and never older once read.
 */
function freshestOutcome(
  fromParent: ProfileCopyOutcome,
  fromDestination: ProfileCopyOutcome | undefined,
): ProfileCopyOutcome {
  if (fromDestination === undefined) return fromParent;
  return fromDestination.revision >= fromParent.revision
    ? fromDestination
    : fromParent;
}

function loginNoticeText(
  notice: ProfileImportLoginNotice,
  names: ProfileCopyNames,
): string {
  switch (notice.kind) {
    case "stale":
      return `This changed on ${names.destination} since you last looked. Review it again.`;
    case "elsewhere":
      return `A sign-in for this copy is already running from another window or device. Finish it there, or let it time out on ${names.destination}.`;
    case "unfinished":
      return "Sign-in didn't finish. Try again.";
    case "lost":
      return `Traycer lost track of the sign-in on ${names.destination}. Showing its latest state.`;
    case "start-failed":
      return `Sign-in didn't start. ${profileCopyRequestErrorText(notice.error, names.destination)}`;
    case "start-refused":
      return profileCopyStartRefusalCopy(notice.reason, names);
    case "cancel-failed":
      return `Couldn't cancel on ${names.destination} — the sign-in may still be running there. Try again.`;
  }
}

/** A revision-bound login notice shows only at the revision it answered. */
function visibleLoginNotice(
  notice: ProfileImportLoginNotice | null,
  revision: number,
): ProfileImportLoginNotice | null {
  if (notice === null) return null;
  if (notice.kind !== "stale" && notice.kind !== "elsewhere") return notice;
  return notice.revision === revision ? notice : null;
}

/** The recorded direct refusal for this attempt at `revision`, or `null`. */
function useCurrentDirectBlock(
  attemptId: string,
  revision: number,
): ProfileCopyDirectBlock | null {
  const stored = useProfileCopyFlowStore(
    (state) => state.directBlocks[attemptId],
  );
  return stored !== undefined && stored.revision === revision ? stored : null;
}

/**
 * A `blocked` row IS the refused click's answer until the re-read lands, so
 * it is worded for the verb that was refused; any other row reads as usual.
 */
function draftPresentation(
  outcome: ProfileCopyOutcome,
  directBlock: ProfileCopyDirectBlock | null,
  context: ProfileCopyOutcomeContext,
): ProfileCopyOutcomePresentation {
  if (directBlock !== null && outcome.state === "blocked") {
    return presentProfileCopyDirectBlock(outcome, directBlock, context.names);
  }
  return presentProfileCopyOutcome(outcome, context);
}

/**
 * The already-present account's real state, as the DESTINATION's own
 * `providers.list` states it (ruling P2-5 (a)): read through the captured
 * destination host, keyed by the outcome's `targetProfileId`. The wire's
 * `targetEnabled` / `targetAuthStatus` are never filled for this state, so
 * they are not read. Nothing renders until the destination answers.
 */
function ProfileCopyExistingProfileFacts(props: {
  readonly attempt: ProfileCopyAttempt;
  readonly profileId: string;
}): ReactNode {
  const existing = useProfileCopyExistingProfile(
    props.attempt.destinationHostId,
    props.attempt.providerId,
    props.profileId,
  );
  if (existing === null) return null;
  return (
    <p className="text-ui-xs text-muted-foreground">
      {profileCopyExistingProfileFacts(existing)}
    </p>
  );
}

type DraftNoticeTone = "warning" | "muted" | "error";

interface DraftNoticeLine {
  readonly key: string;
  readonly tone: DraftNoticeTone;
  readonly text: string;
}

const NOTICE_CLASS_NAME: { readonly [T in DraftNoticeTone]: string } = {
  warning: "text-ui-xs text-warning-foreground",
  muted: "text-ui-xs text-muted-foreground",
  error: "text-ui-xs text-destructive",
};

interface DraftNoticeInput {
  readonly names: ProfileCopyNames;
  readonly revision: number;
  /** The row is `blocked`: its own presentation already says the refusal. */
  readonly rowBlocked: boolean;
  /** The direct refusal recorded at THIS revision, or `null`. */
  readonly directBlock: ProfileCopyDirectBlock | null;
  readonly loginNotice: ProfileImportLoginNotice | null;
  readonly answerNotice: DraftAnswerNotice | null;
  readonly draftError: HostRpcError | null;
  readonly requestError: HostRpcError | null;
}

function noticeLine(
  key: string,
  tone: DraftNoticeTone,
  text: string | null,
): DraftNoticeLine | null {
  return text === null ? null : { key, tone, text };
}

function answerNoticeText(
  input: DraftAnswerNotice | null,
  revision: number,
  names: ProfileCopyNames,
): string | null {
  if (input === null || input.revision !== revision) return null;
  switch (input.kind) {
    case "stale-revision":
      return `This changed on ${names.destination} since you last looked. Review it again.`;
    case "unavailable":
      return `${names.destination} can't do that right now. Another step for this copy may still be running there.`;
    case "verify-unread":
      return `Couldn't read the copied settings on ${names.destination}. Try again.`;
    case "verify-timeout":
      return `${profileCopyReasonCopy("verification-timeout", names).body} Try again.`;
  }
}

function draftErrorText(
  error: HostRpcError | null,
  names: ProfileCopyNames,
): string | null {
  if (error === null) return null;
  return error.code === "E_HOST_UNSUPPORTED"
    ? `Update Traycer on ${names.destination} to continue here.`
    : `Couldn't reach ${names.destination} right now. Showing the last answer ${names.source} had.`;
}

function draftNoticeLines(input: DraftNoticeInput): readonly DraftNoticeLine[] {
  const { names } = input;
  const loginNotice = visibleLoginNotice(input.loginNotice, input.revision);
  const lines = [
    noticeLine(
      "direct-block",
      "warning",
      input.directBlock === null || input.rowBlocked
        ? null
        : profileCopyDirectBlockCopy(input.directBlock, names),
    ),
    noticeLine(
      "login",
      "warning",
      loginNotice === null ? null : loginNoticeText(loginNotice, names),
    ),
    noticeLine(
      "answer",
      "warning",
      answerNoticeText(input.answerNotice, input.revision, names),
    ),
    noticeLine("draft-error", "muted", draftErrorText(input.draftError, names)),
    noticeLine(
      "request-error",
      "error",
      input.requestError === null
        ? null
        : profileCopyRequestErrorText(input.requestError, names.destination),
    ),
  ];
  return lines.filter((line): line is DraftNoticeLine => line !== null);
}

function ProfileCopyDraftNotices(props: {
  readonly lines: readonly DraftNoticeLine[];
}): ReactNode {
  return props.lines.map((line) => (
    <p
      key={line.key}
      className={NOTICE_CLASS_NAME[line.tone]}
      role={line.tone === "error" ? "alert" : "status"}
    >
      {line.text}
    </p>
  ));
}

function ProfileCopyDraftPreference(props: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (desiredEnabled: boolean) => void;
}): ReactNode {
  const preferenceId = useId();
  return (
    <div className="flex items-start gap-2.5 pt-0.5">
      <Switch
        id={preferenceId}
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={props.onChange}
      />
      <label htmlFor={preferenceId} className="flex min-w-0 flex-col">
        <span className="text-ui-xs font-medium text-foreground">
          Let agents use it once it&apos;s ready
        </span>
        <span className="text-ui-xs text-muted-foreground">
          This only sets a preference; it doesn&apos;t finish setup.
        </span>
      </label>
    </div>
  );
}

type DraftButtonVariant = "default" | "destructive" | "outline" | "ghost";

function isCancelAction(action: ProfileCopyDraftAction): boolean {
  return action.kind === "cancel-draft" || action.kind === "cancel-sign-in";
}

function ProfileCopyDraftActionButton(props: {
  readonly action: ProfileCopyDraftAction;
  readonly variant: DraftButtonVariant;
  readonly controller: ProfileCopyDraftController;
}): ReactNode {
  const { action, controller } = props;
  return (
    <Button
      type="button"
      size="sm"
      variant={props.variant}
      disabled={controller.actionDisabled(action)}
      onClick={() => controller.runAction(action)}
    >
      {controller.actionPending(action) ? <MutedAgentSpinner /> : null}
      {action.label}
    </Button>
  );
}

function ProfileCopyDraftActionRow(props: {
  readonly actions: ProfileCopyDraftActions;
  readonly controller: ProfileCopyDraftController;
  /** The host whose sign-in holds this window's interactive slot, by name. */
  readonly otherLoginName: string | null;
  readonly extraActions: ReactNode;
}): ReactNode {
  const { primary, secondary } = props.actions;
  const hasActions =
    primary !== null || secondary.length > 0 || props.extraActions !== null;
  const waitingOnOtherLogin =
    props.otherLoginName !== null &&
    primary !== null &&
    isProfileCopySignInAction(primary);
  return (
    <>
      {hasActions ? (
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          {primary !== null ? (
            <ProfileCopyDraftActionButton
              action={primary}
              variant={
                primary.kind === "cancel-draft" ? "destructive" : "default"
              }
              controller={props.controller}
            />
          ) : null}
          {secondary.map((action) => (
            <ProfileCopyDraftActionButton
              key={action.kind}
              action={action}
              variant={isCancelAction(action) ? "ghost" : "outline"}
              controller={props.controller}
            />
          ))}
          {props.extraActions}
        </div>
      ) : null}
      {waitingOnOtherLogin ? (
        <p className="text-ui-xs text-muted-foreground">
          Finish signing in on {props.otherLoginName} first.
        </p>
      ) : null}
    </>
  );
}

function ProfileCopyDraftCancelDialog(props: {
  readonly pendingConfirm: PendingConfirm | null;
  readonly destinationName: string;
  readonly controller: ProfileCopyDraftController;
}): ReactNode {
  const { destinationName, controller } = props;
  return (
    <ConfirmDestructiveDialog
      open={props.pendingConfirm !== null}
      onOpenChange={(open) => {
        if (!open) controller.dismissCancel();
      }}
      title={`Cancel the copy to ${destinationName}?`}
      description={
        props.pendingConfirm === "cancel-sign-in"
          ? `This stops the sign-in and cancels the copy to ${destinationName}. Nothing already on ${destinationName} is removed.`
          : `Nothing already on ${destinationName} is removed.`
      }
      cascadeSummary={null}
      actionLabel="Cancel copy"
      isPending={controller.cancelPending}
      blockedReason={null}
      onConfirm={controller.confirmCancel}
    />
  );
}

/**
 * One destination-recorded draft: its state, the actions the destination
 * offers, and the live import sign-in when this window drives it.
 *
 * Every read and action dials `outcome.attempt.destinationHostId` - captured
 * with the attempt, never the host Settings shows. Every action carries the
 * revision the user is looking at; an answer other than `current` is shown
 * once as "this changed" and never sent again on the user's behalf.
 */
export function ProfileCopyDraftPanel(props: {
  /** The latest outcome the caller holds (a `status` row or an incoming draft). */
  readonly outcome: ProfileCopyOutcome;
  readonly names: ProfileCopyNames;
  readonly route: ProfileCopyKnownRoute;
  /** The source confirmed this window's cancel of the whole operation. */
  readonly cancelRequested: boolean;
  readonly destinationIsLocal: boolean;
  /** Source-side actions the caller adds (Retry, Copy again), or `null`. */
  readonly extraActions: ReactNode;
}): ReactNode {
  const { names, route } = props;
  const attempt = props.outcome.attempt;
  const attemptId = attempt.attemptId;
  const queryClient = useQueryClient();
  const hosts = useProfileCopyHosts();
  const draft = useProfileCopyDraftStatusQuery(attempt, true);
  const outcome = freshestOutcome(props.outcome, draft.data?.outcome);

  // First sight of a promotion or a settled attempt: refresh the destination
  // and report it once per window (the helper remembers what it has seen).
  useEffect(() => {
    observeProfileCopyOutcome(queryClient, outcome);
  }, [queryClient, outcome]);

  const login = useProfileImportLoginFlow(attempt);
  const controller = useProfileCopyDraftController(attempt, outcome, login);
  const directBlock = useCurrentDirectBlock(attemptId, outcome.revision);
  const presentation = draftPresentation(outcome, directBlock, {
    names,
    route,
    cancelRequested: props.cancelRequested,
  });
  const actions = profileCopyDraftActions(outcome, {
    destinationName: names.destination,
    route,
    directBlock,
    startRefusal: login.startRefusal,
  });
  const notices = draftNoticeLines({
    names,
    revision: outcome.revision,
    rowBlocked: outcome.state === "blocked",
    directBlock,
    loginNotice: login.notice,
    answerNotice: controller.answerNotice,
    draftError: draft.isError ? draft.error : null,
    requestError: controller.requestError,
  });
  const otherLoginHostId = controller.otherLoginHostId;
  const existingProfileId =
    outcome.state === "already-present" ? outcome.targetProfileId : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <ProfileCopyBadge tone={presentation.tone} label={presentation.badge} />
        {draft.isFetching && draft.data === undefined ? (
          <MutedAgentSpinner />
        ) : null}
      </div>
      <p className="text-ui-xs leading-relaxed text-muted-foreground">
        {presentation.body}
      </p>
      {presentation.note !== null ? (
        <p className="text-ui-xs text-muted-foreground">{presentation.note}</p>
      ) : null}
      {existingProfileId !== null ? (
        <ProfileCopyExistingProfileFacts
          attempt={attempt}
          profileId={existingProfileId}
        />
      ) : null}
      <ProfileCopyDraftNotices lines={notices} />
      {profileCopyPreferenceEditable(outcome) ? (
        <ProfileCopyDraftPreference
          checked={outcome.desiredEnabled}
          disabled={controller.preferenceDisabled}
          onChange={controller.setPreference}
        />
      ) : null}
      {login.phase.kind !== "idle" ? (
        <ProfileCopyImportLoginStep
          login={login}
          names={names}
          destinationIsLocal={props.destinationIsLocal}
          onCancel={() => controller.requestCancel("cancel-sign-in")}
        />
      ) : (
        <ProfileCopyDraftActionRow
          actions={actions}
          controller={controller}
          otherLoginName={
            otherLoginHostId === null ? null : hosts.nameFor(otherLoginHostId)
          }
          extraActions={props.extraActions}
        />
      )}
      <ProfileCopyDraftCancelDialog
        pendingConfirm={controller.pendingConfirm}
        destinationName={names.destination}
        controller={controller}
      />
    </div>
  );
}
