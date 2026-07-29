import { useCallback, useEffect, useMemo } from "react";
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
  readonly sessionId: number | null;
  readonly query: string;
  readonly slashScope: ComposerSlashScope | null;
}

function selectSlashSlice(state: {
  open: boolean;
  sessionId: number | null;
  kind: "mention" | "slash" | null;
  query: string;
  slashScope: ComposerSlashScope | null;
}): SlashPickerSlice {
  return {
    active: state.open && state.kind === "slash",
    // Watched, not just reported: a swap to a session with an identical query
    // and scope leaves every other input untouched, and `openPicker` has
    // already dropped the rows. Without the id in the slice this effect never
    // re-runs and the menu stays empty until the next keystroke.
    sessionId: state.kind === "slash" ? state.sessionId : null,
    query: state.kind === "slash" ? state.query : "",
    slashScope: state.kind === "slash" ? state.slashScope : null,
  };
}

export function useSlashItems(params: UseSlashItemsParams): void {
  const { pickerStore, hostClient, harnessId, workingDirectories } = params;

  const slice = useStore(pickerStore, useShallow(selectSlashSlice));
  const { active, sessionId, query, slashScope } = slice;

  const {
    data: commands,
    isLoading,
    isFetching,
    error,
    refetch,
  } = useSlashCommands(query, {
    hostClient,
    harnessId,
    workingDirectories,
    enabled: active,
  });

  const retryLoad = useCallback(() => {
    void refetch();
  }, [refetch]);

  const items = useMemo<ReadonlyArray<ComposerPickerItem>>(
    () => slashItemsForScope(commands, slashScope),
    [commands, slashScope],
  );

  useEffect(() => {
    if (!active || sessionId === null) return;
    // `slashScope` is part of the published identity, not just an input: the
    // store rejects this list if the caret has already flipped the scope since
    // these items were built under it.
    pickerStore.getState().setItems({
      sessionId,
      kind: "slash",
      query,
      slashScope,
      step: STATIC_STEP,
      items,
      loading: isLoading,
      // A failed catalog fetch must render as an error with a retry, never as
      // "No matching commands" - an empty catalog and a dead provider are
      // different states.
      loadFailed: error !== null,
      retryLoad: error !== null ? retryLoad : null,
    });
  }, [
    active,
    error,
    isLoading,
    items,
    pickerStore,
    query,
    retryLoad,
    sessionId,
    slashScope,
  ]);

  useEffect(() => {
    if (!active) return;
    pickerStore.getState().setFetching(isFetching);
  }, [active, isFetching, pickerStore]);
}

/**
 * Projects the fetched catalog into rows for the caret's scope.
 *
 * Scope depends on position, never on which trigger opened the picker - `/` and
 * `$` list the same commands. Past the start of the prompt a native command
 * stays listed and explains itself rather than vanishing, because the user
 * asked for the catalog and a row disappearing mid-typing reads as a bug.
 */
export function slashItemsForScope(
  commands: ReadonlyArray<SlashCommand>,
  slashScope: ComposerSlashScope | null,
): ReadonlyArray<ComposerPickerItem> {
  return commands.map((command: SlashCommand): ComposerPickerItem => {
    // Native provider commands are parsed only at the very start of the prompt
    // (the Claude CLI bails unless the trimmed prompt starts with `/`), so
    // inline they stay listed but unselectable.
    const disabled = slashScope === "skills" && command.kind !== "skill";
    return {
      id: `slash:${command.name}`,
      kind: "slash",
      command,
      disabledReason: disabled ? NATIVE_COMMAND_DISABLED_REASON : null,
    };
  });
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
