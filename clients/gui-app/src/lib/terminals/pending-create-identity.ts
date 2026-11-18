import { plainTerminalFleetIdentityKey } from "@traycer/protocol/host/terminal/plain-schemas";

function withMarker(
  pending: ReadonlySet<string>,
  marker: string,
): ReadonlySet<string> {
  if (pending.has(marker)) return pending;
  const next = new Set(pending);
  next.add(marker);
  return next;
}

function withoutMarker(
  pending: ReadonlySet<string>,
  marker: string,
): ReadonlySet<string> {
  if (!pending.has(marker)) return pending;
  const next = new Set(pending);
  next.delete(marker);
  return next;
}

export function terminalPendingCreateMarker(
  hostId: string,
  terminalId: string,
): string {
  return plainTerminalFleetIdentityKey({ hostId, terminalId });
}

export function epicTerminalUiIdentityKey(
  namespace: "session" | "failed",
  hostId: string,
  terminalId: string,
): string {
  return `${namespace}:${terminalPendingCreateMarker(hostId, terminalId)}`;
}

export function hasTerminalPendingCreate(
  pending: ReadonlySet<string>,
  hostId: string,
  terminalId: string,
): boolean {
  return pending.has(terminalPendingCreateMarker(hostId, terminalId));
}

export function withTerminalPendingCreate(
  pending: ReadonlySet<string>,
  hostId: string,
  terminalId: string,
): ReadonlySet<string> {
  return withMarker(pending, terminalPendingCreateMarker(hostId, terminalId));
}

export function withoutTerminalPendingCreate(
  pending: ReadonlySet<string>,
  hostId: string,
  terminalId: string,
): ReadonlySet<string> {
  return withoutMarker(
    pending,
    terminalPendingCreateMarker(hostId, terminalId),
  );
}

export function failedCreateHasAuthoritativeRow(args: {
  readonly jobHostId: string;
  readonly jobTerminalId: string;
  readonly sessionHostId: string;
  readonly durableHasTerminalId: (terminalId: string) => boolean;
}): boolean {
  if (args.jobHostId !== args.sessionHostId) return false;
  return args.durableHasTerminalId(args.jobTerminalId);
}
