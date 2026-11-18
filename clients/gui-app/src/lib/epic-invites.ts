import type { IdentifierType } from "@traycer/protocol/host/epic/unary-schemas";
import type { EpicCollaboratorView } from "@/hooks/epics/use-epic-collaborators-query";
import type { AssignableCollaboratorRole } from "@/lib/epic-collaborator-roles";

export interface ParsedInviteIdentifier {
  readonly identifier: string;
  readonly identifierType: InviteIdentifierType;
}

export interface QueuedInvite extends ParsedInviteIdentifier {
  readonly role: AssignableCollaboratorRole;
}

export interface InviteValidationArgs {
  readonly parsedInvite: ParsedInviteIdentifier | null;
  readonly queuedInvites: ReadonlyArray<QueuedInvite>;
  readonly isInvitePending: boolean;
}

export interface InviteValidation {
  readonly inputError: string | null;
  readonly canAddInvite: boolean;
}

export type InviteIdentifierType = Extract<
  IdentifierType,
  "email" | "github_handle"
>;

export function parseInviteIdentifier(
  rawValue: string,
): ParsedInviteIdentifier | null {
  const value = rawValue.trim();
  if (value.length === 0) return null;
  if (isValidEmail(value)) {
    return { identifier: value, identifierType: "email" };
  }
  const handle = value.replace(/^@/, "");
  if (!isValidGithubHandle(handle)) return null;
  return { identifier: handle, identifierType: "github_handle" };
}

export function validateInviteInput(
  args: InviteValidationArgs,
): InviteValidation {
  const { parsedInvite, queuedInvites, isInvitePending } = args;
  if (parsedInvite === null) {
    return { inputError: null, canAddInvite: false };
  }
  const key = inviteKey(parsedInvite);
  if (queuedInvites.some((invite) => inviteKey(invite) === key)) {
    return { inputError: "Already in the invite queue.", canAddInvite: false };
  }
  return { inputError: null, canAddInvite: !isInvitePending };
}

export function inviteKey(invite: ParsedInviteIdentifier): string {
  return `${invite.identifierType}:${normalizeInviteIdentifier(invite)}`;
}

export function formatInviteLabel(invite: ParsedInviteIdentifier): string {
  if (invite.identifierType === "email") return invite.identifier;
  return formatGithubHandle(invite.identifier);
}

export function formatGithubHandle(handle: string): string {
  if (handle.length === 0) return "";
  return handle.startsWith("@") ? handle : `@${handle}`;
}

export function collaboratorMatchesInvite(
  row: Pick<EpicCollaboratorView, "email" | "handle">,
  invite: ParsedInviteIdentifier,
): boolean {
  if (invite.identifierType === "email") {
    return normalizeEmail(row.email) === normalizeEmail(invite.identifier);
  }
  return (
    normalizeGithubHandle(row.handle) ===
    normalizeGithubHandle(invite.identifier)
  );
}

export function buildExistingInviteIndex(
  collaborators: ReadonlyArray<EpicCollaboratorView>,
): ReadonlyMap<string, string> {
  const entries: Array<[string, string]> = [];
  collaborators.forEach((collaborator) => {
    const userId = collaborator.userId;
    if (userId === null) return;
    collaboratorInviteIdentifiers(collaborator).forEach((identifier) => {
      entries.push([inviteKey(identifier), userId]);
    });
  });
  return new Map(entries);
}

function collaboratorInviteIdentifiers(
  collaborator: EpicCollaboratorView,
): ReadonlyArray<ParsedInviteIdentifier> {
  const identifiers: ParsedInviteIdentifier[] = [];
  if (collaborator.email.length > 0) {
    identifiers.push({
      identifier: collaborator.email,
      identifierType: "email",
    });
  }
  if (collaborator.handle.length > 0) {
    identifiers.push({
      identifier: collaborator.handle,
      identifierType: "github_handle",
    });
  }
  return identifiers;
}

function normalizeInviteIdentifier(invite: ParsedInviteIdentifier): string {
  if (invite.identifierType === "email")
    return normalizeEmail(invite.identifier);
  return normalizeGithubHandle(invite.identifier);
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeGithubHandle(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidGithubHandle(value: string): boolean {
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(value);
}
