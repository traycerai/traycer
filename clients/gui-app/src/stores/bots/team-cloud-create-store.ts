import { useEffect } from "react";
import { create } from "zustand";
import type { SandboxListResponse } from "@traycer/protocol/host/sandbox-control";

/**
 * A team's Enable cloud create, from the press until the sandbox list carries
 * the sandbox it made. `requestKey` is reused until the server accepts the
 * create or refuses it before creating anything (an unanswered request may
 * already have created one); `pending` while the request is out;
 * `acceptedSandboxId` once the server answered with the sandbox.
 */
export interface TeamCloudCreate {
  readonly requestKey: string | null;
  readonly pending: boolean;
  readonly acceptedSandboxId: string | null;
}

interface TeamCloudCreateState {
  readonly byEnvironmentId: Readonly<Partial<Record<string, TeamCloudCreate>>>;
  /** The create for `environmentId` was sent with `requestKey`. */
  readonly start: (environmentId: string, requestKey: string) => void;
  /** The server accepted it and made `sandboxId`. */
  readonly accept: (environmentId: string, sandboxId: string) => void;
  /** It failed; `keepKey` when the server may still have created one. */
  readonly fail: (environmentId: string, keepKey: boolean) => void;
  /** The list carries `sandboxId`: the list now speaks for the team. */
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
    start: (environmentId, requestKey) =>
      set((state) => ({
        byEnvironmentId: {
          ...state.byEnvironmentId,
          [environmentId]: {
            requestKey,
            pending: true,
            acceptedSandboxId: null,
          },
        },
      })),
    accept: (environmentId, sandboxId) =>
      set((state) => ({
        byEnvironmentId: {
          ...state.byEnvironmentId,
          [environmentId]: {
            requestKey: null,
            pending: false,
            acceptedSandboxId: sandboxId,
          },
        },
      })),
    fail: (environmentId, keepKey) =>
      set((state) => {
        const entry = state.byEnvironmentId[environmentId];
        if (entry === undefined) return state;
        return {
          byEnvironmentId: {
            ...state.byEnvironmentId,
            [environmentId]: {
              requestKey: keepKey ? entry.requestKey : null,
              pending: false,
              acceptedSandboxId: null,
            },
          },
        };
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
 * `environmentId`'s Enable cloud create, settled once `list` carries the
 * sandbox it made: from then on the list says the team has its sandbox.
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
  const listed =
    accepted !== null &&
    (list?.sandboxes.some((summary) => summary.id === accepted) ?? false);
  useEffect(() => {
    if (listed) settle(environmentId, accepted);
  }, [accepted, environmentId, listed, settle]);
  return entry;
}
