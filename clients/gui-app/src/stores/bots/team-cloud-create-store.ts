import { useEffect } from "react";
import { create } from "zustand";
import type { SandboxListResponse } from "@traycer/protocol/host/sandbox-control";
import { sandboxListReadSentAt } from "@/hooks/sandboxes/use-sandbox-list-query";

/**
 * A team's Enable cloud create, from the press until the sandbox list carries
 * the sandbox it made. `pending` while the request is out;
 * `acceptedSandboxId` once the server answered with the sandbox, and
 * `acceptedAt` when this app received that answer (epoch milliseconds).
 */
export interface TeamCloudCreate {
  readonly pending: boolean;
  readonly acceptedSandboxId: string | null;
  readonly acceptedAt: number | null;
}

interface TeamCloudCreateState {
  readonly byEnvironmentId: Readonly<Partial<Record<string, TeamCloudCreate>>>;
  readonly start: (environmentId: string) => void;
  /** The server accepted it and made `sandboxId`; this app heard at `acceptedAt`. */
  readonly accept: (
    environmentId: string,
    sandboxId: string,
    acceptedAt: number,
  ) => void;
  readonly fail: (environmentId: string) => void;
  /** A list read since `sandboxId` was accepted speaks for the team. */
  readonly settle: (environmentId: string, sandboxId: string) => void;
}

/**
 * Each team's Enable cloud create, by environment id, held outside the setup
 * card so a card that unmounts and mounts again (the tab closed and opened,
 * the pane swapped) still knows a create is out or was accepted, and adds no
 * second sandbox. Not persisted: a restart reads the list again.
 */
export const useTeamCloudCreateStore = create<TeamCloudCreateState>()(
  (set) => ({
    byEnvironmentId: {},
    start: (environmentId) =>
      set((state) => ({
        byEnvironmentId: {
          ...state.byEnvironmentId,
          [environmentId]: {
            pending: true,
            acceptedSandboxId: null,
            acceptedAt: null,
          },
        },
      })),
    accept: (environmentId, sandboxId, acceptedAt) =>
      set((state) => ({
        byEnvironmentId: {
          ...state.byEnvironmentId,
          [environmentId]: {
            pending: false,
            acceptedSandboxId: sandboxId,
            acceptedAt,
          },
        },
      })),
    fail: (environmentId) =>
      set((state) => {
        if (state.byEnvironmentId[environmentId]?.pending !== true)
          return state;
        const next = { ...state.byEnvironmentId };
        delete next[environmentId];
        return { byEnvironmentId: next };
      }),
    settle: (environmentId, sandboxId) =>
      set((state) => {
        if (
          state.byEnvironmentId[environmentId]?.acceptedSandboxId !== sandboxId
        ) {
          return state;
        }
        const next = { ...state.byEnvironmentId };
        delete next[environmentId];
        return { byEnvironmentId: next };
      }),
  }),
);

/**
 * `environmentId`'s Enable cloud create, settled once `list` speaks for the
 * team: it carries the sandbox the create made, or it is a read sent after
 * the create was accepted, so a sandbox absent from it is gone (destroyed
 * rows are not listed). A read sent before, or kept through a failed
 * refresh, may predate the sandbox and settles nothing.
 */
export function useTeamCloudCreate(
  environmentId: string,
  list: SandboxListResponse | null | undefined,
): TeamCloudCreate | undefined {
  const entry = useTeamCloudCreateStore(
    (state) => state.byEnvironmentId[environmentId],
  );
  const settle = useTeamCloudCreateStore((state) => state.settle);
  const accepted = entry?.acceptedSandboxId ?? null;
  const acceptedAt = entry?.acceptedAt ?? null;
  const sentAt = sandboxListReadSentAt(list);
  const settled =
    accepted !== null &&
    ((list?.sandboxes.some((summary) => summary.id === accepted) ?? false) ||
      (sentAt !== null && acceptedAt !== null && sentAt > acceptedAt));
  useEffect(() => {
    if (settled) settle(environmentId, accepted);
  }, [accepted, environmentId, settled, settle]);
  return entry;
}
