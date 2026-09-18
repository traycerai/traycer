import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import {
  customizeLayoutAction,
  openSampleWorkspaceAction,
} from "@/lib/commands/actions/customize-layout";
import type { CommandItem, ReactCommandSource } from "@/lib/commands/types";
import { readCustomizeLease } from "@/lib/customize/lease";
import { useWindowsBridge } from "@/providers/windows-bridge-context";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import { useSettingsStore } from "@/stores/settings/settings-store";

export const customizeSource: ReactCommandSource = {
  id: "customize",
  useItems: () => {
    const navigate = useNavigate();
    const enabled = useSettingsStore(
      (state) => state.visualLayoutEditorEnabled,
    );
    const mobile = useIsMobileViewport();
    const locked = useCustomizeStore(
      (state) => state.lockedBy === "other-window",
    );
    const bridge = useWindowsBridge();
    return useMemo<ReadonlyArray<CommandItem>>(() => {
      if (!enabled || mobile) return [];
      const common = {
        keywords: ["layout", "customize", "appearance"],
        group: "actions",
        scope: "actions",
        shortcut: null,
        actionId: null,
        subpage: null,
      } as const;
      if (locked)
        return [
          {
            ...common,
            id: "customize:locked",
            label: "Finish customizing in the other window",
            description: null,
            disabled: true,
            run: () => undefined,
          },
          ...(bridge
            ? [
                {
                  ...common,
                  id: "customize:focus",
                  label: "Focus customizing window",
                  description: null,
                  run: () => {
                    const lease = readCustomizeLease();
                    if (lease) void bridge.requestFocus(lease.token);
                  },
                },
              ]
            : []),
        ];
      return [
        {
          ...common,
          id: "customize:layout",
          label: "Customize layout",
          description: "Point at the app's controls to change their layout",
          run: () => customizeLayoutAction("command_palette"),
        },
        {
          ...common,
          id: "customize:sample",
          label: "Open sample workspace",
          description: "Customize with a populated example",
          run: () => openSampleWorkspaceAction(navigate),
        },
      ];
    }, [enabled, mobile, locked, bridge, navigate]);
  },
};
