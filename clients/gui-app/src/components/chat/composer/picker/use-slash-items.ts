import { useEffect, useMemo } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { GuiHarnessId } from "@traycer/protocol/host/index";

import { useSlashCommands } from "@/hooks/composer/use-slash-commands";
import type { HostRpcRegistry } from "@/lib/host";
import type { SlashCommand } from "@/lib/composer/types";

import type {
  ComposerPickerItem,
  ComposerPickerStore,
  ComposerSlashScope,
} from "./composer-picker-store";

export interface UseSlashItemsParams {
  readonly pickerStore: ComposerPickerStore;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly harnessId: GuiHarnessId;
  readonly workingDirectories: ReadonlyArray<string>;
}

interface SlashPickerSlice {
  readonly active: boolean;
  readonly query: string;
  readonly slashScope: ComposerSlashScope | null;
}

function selectSlashSlice(state: {
  open: boolean;
  kind: "mention" | "slash" | null;
  query: string;
  slashScope: ComposerSlashScope | null;
}): SlashPickerSlice {
  return {
    active: state.open && state.kind === "slash",
    query: state.kind === "slash" ? state.query : "",
    slashScope: state.kind === "slash" ? state.slashScope : null,
  };
}

export function useSlashItems(params: UseSlashItemsParams): void {
  const { pickerStore, hostClient, harnessId, workingDirectories } = params;

  const slice = useStore(pickerStore, useShallow(selectSlashSlice));
  const { active, query, slashScope } = slice;
  const skillsOnly = slashScope === "skills";

  const {
    data: commands,
    isLoading,
    isFetching,
  } = useSlashCommands(query, {
    hostClient,
    harnessId,
    workingDirectories,
    enabled: active,
  });

  const items = useMemo<ReadonlyArray<ComposerPickerItem>>(
    () =>
      commands.map((command: SlashCommand) => {
        // Native provider commands are parsed only at the very start of the
        // prompt (the Claude CLI bails unless the trimmed prompt starts with
        // `/`), so inline they stay listed but unselectable rather than
        // vanishing - the catalog reads the same at every caret position.
        const disabled = skillsOnly && command.kind !== "skill";
        return {
          id: `slash:${command.name}`,
          kind: "slash",
          command,
          disabledReason: disabled ? NATIVE_COMMAND_DISABLED_REASON : null,
        };
      }),
    [commands, skillsOnly],
  );

  useEffect(() => {
    if (!active) return;
    // `slashScope` is part of the published identity, not just an input: the
    // store rejects this list if the caret has already flipped the scope since
    // these items were built under it.
    pickerStore.getState().setItems({
      kind: "slash",
      query,
      slashScope,
      step: STATIC_STEP,
      items,
      loading: isLoading,
    });
  }, [active, isLoading, items, pickerStore, query, slashScope]);

  useEffect(() => {
    if (!active) return;
    pickerStore.getState().setFetching(isFetching);
  }, [active, isFetching, pickerStore]);
}

const STATIC_STEP = { kind: "root" as const };

/**
 * Rendered twice for the highlighted row: as the preview panel's disabled
 * notice, and as the row's screen-reader-only text. Both prefix it with
 * "Disabled", so the wording has to read as a standalone sentence following
 * that word.
 */
export const NATIVE_COMMAND_DISABLED_REASON =
  "This command is only allowed at the start of the message";
