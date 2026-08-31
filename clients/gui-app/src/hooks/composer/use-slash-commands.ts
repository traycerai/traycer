import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  GuiAgentCommandOption,
  GuiHarnessId,
} from "@traycer/protocol/host/index";
import { useGuiHarnessCommandsQuery } from "@/hooks/harnesses/use-gui-harness-catalog";
import type { HostRpcRegistry } from "@/lib/host";
import { rankSlashCommands } from "@/lib/composer/slash-command-ranking";
import type {
  MentionPreview,
  ProviderSlashCommand,
  SlashCommand,
} from "@/lib/composer/types";

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
  /**
   * Renderer-handled commands listed AHEAD of the provider catalog and winning
   * the name dedupe below, so a local `/btw` shadows a provider's same-named
   * command in the picker and in the raw-text converter alike - the local one
   * is the one this surface will actually honor. Pass
   * {@link NO_LOCAL_SLASH_COMMANDS} (a stable empty list) where none apply.
   */
  readonly localCommands: ReadonlyArray<SlashCommand>;
}

export const NO_LOCAL_SLASH_COMMANDS: ReadonlyArray<SlashCommand> = [];

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
  const localCommands = params.localCommands;
  const allCommands = useMemo<ReadonlyArray<SlashCommand>>(() => {
    const providerCommands: ReadonlyArray<ProviderSlashCommand> = (
      commandsQuery.data?.commands ?? []
    ).map((command): ProviderSlashCommand => ({
      ...command,
      source: "provider",
      preview: slashCommandPreview(command),
    }));
    return dedupeSlashCommands([
      ...localCommands,
      ...providerCommands,
    ]).toSorted(compareCommandNames);
  }, [commandsQuery.data?.commands, localCommands]);
  const data = useMemo<ReadonlyArray<SlashCommand>>(
    () => rankSlashCommands(allCommands, trimmed),
    [allCommands, trimmed],
  );

  return {
    data,
    isLoading: params.enabled && commandsQuery.isPending,
    isFetching: params.enabled && commandsQuery.isFetching,
    error: commandsQuery.error,
    refetch: commandsQuery.refetch,
  };
}

/**
 * The full command description plus its usage hint (when the command takes
 * arguments), as the preview panel's single named field for a slash entry.
 */
function slashCommandPreview(command: GuiAgentCommandOption): MentionPreview {
  const usage = command.argumentHint;
  return {
    kind: "text",
    primary:
      usage === null || usage.length === 0
        ? command.description
        : `${command.description} ${usage}`,
    secondary: null,
    mono: false,
  };
}

function dedupeSlashCommands(
  commands: ReadonlyArray<SlashCommand>,
): ReadonlyArray<SlashCommand> {
  const byName = new Map<string, SlashCommand>();
  for (const command of commands) {
    const key = command.name.toLowerCase();
    if (!byName.has(key)) {
      byName.set(key, command);
    }
  }
  return Array.from(byName.values());
}
