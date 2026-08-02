import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { useGuiHarnessCommandsQuery } from "@/hooks/harnesses/use-gui-harness-catalog";
import type { HostRpcRegistry } from "@/lib/host";
import { slashCommandsFromOptions } from "@/lib/composer/slash-command-catalog";
import type { SlashCommand } from "@/lib/composer/types";

export interface UseSlashCommandsResult {
  data: ReadonlyArray<SlashCommand>;
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
}

export interface UseSlashCommandsParams {
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly harnessId: GuiHarnessId;
  readonly workingDirectories: ReadonlyArray<string>;
  readonly enabled: boolean;
}

function rankCommand(command: SlashCommand, query: string): number {
  const lower = query.toLowerCase();
  const name = command.name.toLowerCase();
  if (name === lower) return 0;
  if (name.startsWith(lower)) return 1;
  if (command.argumentHint?.toLowerCase().includes(lower)) return 2;
  if (command.description.toLowerCase().includes(lower)) return 2;
  if (command.kind.toLowerCase().includes(lower)) return 3;
  return 3;
}

function compareCommandNames(left: SlashCommand, right: SlashCommand): number {
  return left.name.localeCompare(right.name, undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

export function useSlashCommands(
  query: string,
  params: UseSlashCommandsParams,
): UseSlashCommandsResult {
  const commandsQuery = useGuiHarnessCommandsQuery(
    params.hostClient,
    params.harnessId,
    params.workingDirectories,
    { enabled: params.enabled, subscribed: params.enabled },
  );
  const trimmed = query.trim();
  const allCommands = useMemo<ReadonlyArray<SlashCommand>>(
    () =>
      slashCommandsFromOptions(commandsQuery.data?.commands ?? []).toSorted(
        compareCommandNames,
      ),
    [commandsQuery.data?.commands],
  );
  const data = useMemo<ReadonlyArray<SlashCommand>>(() => {
    if (!trimmed) return allCommands;
    const lower = trimmed.toLowerCase();
    return allCommands
      .filter(
        (cmd) =>
          cmd.name.toLowerCase().includes(lower) ||
          cmd.description.toLowerCase().includes(lower) ||
          (cmd.argumentHint?.toLowerCase().includes(lower) ?? false) ||
          cmd.kind.toLowerCase().includes(lower),
      )
      .toSorted((left, right) => {
        const rankDiff = rankCommand(left, lower) - rankCommand(right, lower);
        if (rankDiff !== 0) return rankDiff;
        return compareCommandNames(left, right);
      });
  }, [allCommands, trimmed]);

  return {
    data,
    isLoading: params.enabled && commandsQuery.isPending,
    isFetching: params.enabled && commandsQuery.isFetching,
    error: commandsQuery.error,
    refetch: commandsQuery.refetch,
  };
}
