import { useEffect, useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { GuiHarnessId } from "@traycer/protocol/host/index";

import { useSlashCommands } from "@/hooks/composer/use-slash-commands";
import type { HostRpcRegistry } from "@/lib/host";

import type { ComposerPickerStore } from "./composer-picker-store";
import { useMentionItems } from "./use-mention-items";
import { useSlashItems } from "./use-slash-items";

export interface UseComposerPickerItemsParams {
  readonly pickerStore: ComposerPickerStore;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly harnessId: GuiHarnessId;
  readonly mentionRoots: ReadonlyArray<string>;
  readonly currentEpicId: string | null;
  // Whether this composer is the active/focused one. Gates the eager
  // command-catalog fetch so inactive-but-mounted composers (e.g. hidden chat
  // tiles) do not subscribe to `agent.gui.listCommands`.
  readonly isActive: boolean;
}

// Mount this on every composer surface; without it the picker menu opens empty.
// The @-mention chat list is sourced inside `useMentionItems` (gated on the
// picker being open), so it is no longer threaded in as a prop.
export function useComposerPickerItems(
  params: UseComposerPickerItemsParams,
): void {
  useMentionItems({
    pickerStore: params.pickerStore,
    hostClient: params.hostClient,
    mentionRoots: params.mentionRoots,
    currentEpicId: params.currentEpicId,
  });
  useSlashItems({
    pickerStore: params.pickerStore,
    hostClient: params.hostClient,
    harnessId: params.harnessId,
    workingDirectories: params.mentionRoots,
  });
  useKnownSlashCommandNames(params);
}

// Eagerly loads the slash-command catalog for the *active* composer (independent
// of the popover being open) and mirrors a lowercased name -> canonical name map
// into the picker store. The paste handler reads this to convert a pasted
// `/command` into a chip only when it is a real command. Gated on `isActive` so
// inactive-but-mounted composers do not fetch `agent.gui.listCommands`; their
// `knownSlashCommands` stays null (a composer you cannot focus cannot be pasted
// into). Shares the cached query with the popover, so it opens against warm data.
function useKnownSlashCommandNames(params: UseComposerPickerItemsParams): void {
  const { data: commands, isLoading } = useSlashCommands("", {
    hostClient: params.hostClient,
    harnessId: params.harnessId,
    workingDirectories: params.mentionRoots,
    enabled: params.isActive,
  });
  const knownCommands = useMemo<ReadonlyMap<string, string> | null>(
    () =>
      params.isActive && !isLoading
        ? new Map(
            commands.map((command) => [
              command.name.toLowerCase(),
              command.name,
            ]),
          )
        : null,
    [params.isActive, commands, isLoading],
  );
  useEffect(() => {
    params.pickerStore.getState().setKnownSlashCommands(knownCommands);
  }, [knownCommands, params.pickerStore]);
}
