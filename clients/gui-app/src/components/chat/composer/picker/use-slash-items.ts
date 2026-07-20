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
}

function selectSlashSlice(state: {
  open: boolean;
  kind: "mention" | "slash" | null;
  query: string;
}): SlashPickerSlice {
  return {
    active: state.open && state.kind === "slash",
    query: state.kind === "slash" ? state.query : "",
  };
}

export function useSlashItems(params: UseSlashItemsParams): void {
  const { pickerStore, hostClient, harnessId, workingDirectories } = params;

  const slice = useStore(pickerStore, useShallow(selectSlashSlice));
  const { active, query } = slice;

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
    () =>
      commands.map((command: SlashCommand) => ({
        id: `slash:${command.name}`,
        kind: "slash",
        command,
      })),
    [commands],
  );

  useEffect(() => {
    if (!active) return;
    pickerStore.getState().setItems({
      kind: "slash",
      query,
      step: STATIC_STEP,
      items,
      loading: isLoading,
      // A failed catalog fetch must render as an error with a retry, never as
      // "No matching commands" - an empty catalog and a dead provider are
      // different states.
      loadFailed: error !== null,
      retryLoad: error !== null ? retryLoad : null,
    });
  }, [active, error, isLoading, items, pickerStore, query, retryLoad]);

  useEffect(() => {
    if (!active) return;
    pickerStore.getState().setFetching(isFetching);
  }, [active, isFetching, pickerStore]);
}

const STATIC_STEP = { kind: "root" as const };
