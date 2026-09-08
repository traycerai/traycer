import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  GuiAgentCommandOption,
  GuiHarnessId,
} from "@traycer/protocol/host/index";
import {
  useGuiHarnessCommandsQuery,
  useHarnessCatalogProfileScope,
} from "@/hooks/harnesses/use-gui-harness-catalog";
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
  /**
   * A managed profile is selected and this composer's host negotiated a
   * `agent.gui.listCommands` line too old to answer for one (D17/D21). No
   * request went out and `data` carries the surface's LOCAL commands only.
   *
   * Deliberately not surfaced through `error`: that channel renders as a
   * failed fetch with a retry, and a retry cannot make a host newer.
   */
  profileUnsupported: boolean;
}

export interface UseSlashCommandsParams {
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly harnessId: GuiHarnessId;
  /**
   * The composer's selected profile (D17/D25, W3-T6). A managed profile's
   * skills live under that profile's home, so the palette must ask for the
   * profile the send will actually run on; `null` is the default account.
   */
  readonly profileId: string | null;
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
  // The version gate lives inside `useGuiHarnessCommandsQuery`, so the request
  // is already held; what this hook owns is the REPORTING. A disabled query
  // with no cached data reports `isPending` forever, so passing it through raw
  // would leave every slash surface spinning for a fetch that will never
  // start - the same trap the picker's `modelsPending` documents.
  const scope = useHarnessCatalogProfileScope(
    params.hostClient?.getActiveHostId() ?? null,
    params.profileId,
  );
  const commandsQuery = useGuiHarnessCommandsQuery(
    params.hostClient,
    {
      harnessId: params.harnessId,
      workingDirectories: params.workingDirectories,
      profileId: scope.profileId,
    },
    { enabled: params.enabled, subscribed: params.enabled },
  );
  const fetching = params.enabled && scope.status === "ready";
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
    // A pending handshake IS a fetch coming: the verdict lands with the
    // manifest and the query starts on that render.
    isLoading:
      params.enabled &&
      (scope.status === "pending" || (fetching && commandsQuery.isPending)),
    isFetching: fetching && commandsQuery.isFetching,
    error: commandsQuery.error,
    refetch: commandsQuery.refetch,
    profileUnsupported: scope.status === "unsupported",
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
