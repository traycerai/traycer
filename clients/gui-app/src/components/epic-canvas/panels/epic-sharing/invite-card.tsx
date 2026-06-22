import { Info, Mail, X } from "lucide-react";
import { useId, type KeyboardEvent } from "react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { RoleDropdown } from "./role-control";
import type { AssignableCollaboratorRole } from "@/lib/epic-collaborator-roles";
import {
  formatInviteLabel,
  inviteKey,
  type QueuedInvite,
} from "@/lib/epic-invites";
import { cn } from "@/lib/utils";

export interface InviteCardProps {
  readonly inviteInput: string;
  readonly inputError: string | null;
  readonly selectedRole: AssignableCollaboratorRole;
  readonly queuedInvites: ReadonlyArray<QueuedInvite>;
  readonly isPending: boolean;
  readonly canAddInvite: boolean;
  readonly onInputChange: (value: string) => void;
  readonly onRoleChange: (value: AssignableCollaboratorRole) => void;
  readonly onAddToQueue: () => void;
  readonly onRemoveFromQueue: (invite: QueuedInvite) => void;
  readonly onSendInvites: () => void;
}

export function InviteCard(props: InviteCardProps) {
  const errorId = useId();
  const {
    inviteInput,
    inputError,
    selectedRole,
    queuedInvites,
    isPending,
    canAddInvite,
    onInputChange,
    onRoleChange,
    onAddToQueue,
    onRemoveFromQueue,
    onSendInvites,
  } = props;

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (!canAddInvite) return;
    onAddToQueue();
  };
  const hasQueuedGithubInvite = queuedInvites.some(
    (invite) => invite.identifierType === "github_handle",
  );

  return (
    <div
      className="flex flex-col gap-3"
      data-testid="invite-card"
      aria-busy={isPending}
    >
      <div className="relative">
        <Input
          type="text"
          value={inviteInput}
          onChange={(event) => {
            onInputChange(event.target.value);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Enter email or GitHub handle"
          className={cn(
            "h-9 w-full min-w-0 pr-14",
            inputError !== null && "border-destructive",
          )}
          aria-label="Email or GitHub handle"
          aria-describedby={inputError !== null ? errorId : undefined}
          aria-invalid={inputError !== null}
          disabled={isPending}
          data-testid="invite-identifier-input"
        />
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onAddToQueue}
          disabled={!canAddInvite}
          data-testid="invite-add-button"
          className="absolute top-1/2 right-2 -translate-y-1/2 text-ui-sm text-muted-foreground disabled:opacity-40"
        >
          Add
        </Button>
      </div>

      {inputError !== null ? (
        <p
          id={errorId}
          className="text-ui-xs text-destructive"
          data-testid="invite-identifier-error"
        >
          {inputError}
        </p>
      ) : null}

      {queuedInvites.length > 0 ? (
        <ul
          className="flex flex-wrap gap-2"
          aria-label="Pending invites"
          data-testid="invite-queue"
        >
          {queuedInvites.map((invite) => (
            <InviteChip
              key={inviteKey(invite)}
              invite={invite}
              isPending={isPending}
              onRemove={() => {
                onRemoveFromQueue(invite);
              }}
            />
          ))}
          {hasQueuedGithubInvite ? <GithubHandleInviteInfo /> : null}
        </ul>
      ) : null}

      <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-2">
        <RoleDropdown
          value={selectedRole}
          onChange={onRoleChange}
          disabled={isPending}
          isPending={false}
          className="h-9 min-w-0 rounded-md border border-input bg-background px-3"
          aria-label="Role for new invites"
          data-testid="invite-role-select"
        />
        <Button
          type="button"
          size="lg"
          onClick={() => {
            onSendInvites();
          }}
          disabled={queuedInvites.length === 0 || isPending}
          data-testid="invite-send-button"
          className="h-9 w-full justify-center"
        >
          {isPending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          {buildInviteActionLabel(queuedInvites.length)}
        </Button>
      </div>
    </div>
  );
}

function InviteChip(props: {
  invite: QueuedInvite;
  isPending: boolean;
  onRemove: () => void;
}) {
  const { invite, isPending, onRemove } = props;
  const label = formatInviteLabel(invite);
  return (
    <li
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted/35 px-2.5 py-1 text-ui-sm text-foreground"
      data-testid="invite-queue-item"
    >
      {invite.identifierType === "email" ? (
        <Mail className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <GithubMarkIcon className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 truncate">{label}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={onRemove}
        disabled={isPending}
        className="size-5 rounded-full text-muted-foreground hover:text-destructive"
        aria-label={`Remove ${label} from queue`}
        data-testid="invite-queue-remove"
      >
        <X className="size-3.5" />
      </Button>
    </li>
  );
}

function GithubMarkIcon(props: { readonly className: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={props.className}
    >
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.1 3.29 9.4 7.86 10.93.58.1.79-.25.79-.56v-2.17c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.25.45-2.28 1.18-3.08-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.16 1.18A10.94 10.94 0 0 1 12 6.05c.98 0 1.96.13 2.88.39 2.19-1.49 3.15-1.18 3.15-1.18.63 1.58.24 2.75.12 3.04.74.8 1.18 1.83 1.18 3.08 0 4.42-2.69 5.39-5.25 5.67.42.36.78 1.06.78 2.14v3.18c0 .31.21.67.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

function GithubHandleInviteInfo() {
  return (
    <li className="inline-flex items-center">
      <TooltipWrapper
        label="GitHub handle invites may not receive an email notification."
        side="top"
        sideOffset={6}
        align="center"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7 rounded-full text-muted-foreground"
          aria-label="GitHub handle invite email notification note"
          data-testid="github-handle-invite-info"
        >
          <Info className="size-3.5" />
        </Button>
      </TooltipWrapper>
    </li>
  );
}

function buildInviteActionLabel(count: number): string {
  if (count === 0) return "Invite";
  if (count === 1) return "Invite 1 person";
  return `Invite ${count} people`;
}
