import { useCallback, useEffect, useRef } from "react";
import type { CustomizeSettingId } from "@/lib/customize/catalog";
import {
  useCustomizeStore,
  type HotspotInstance,
} from "@/stores/customize/customize-store";
import { useEpicViewTabId } from "@/components/epic-canvas/view-tab-context";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";

export function useLayoutHotspot(input: {
  settingId: CustomizeSettingId;
  tileId: string | null;
  ghost: boolean;
  condition: string | null;
}): {
  readonly ref: (node: HTMLElement | null) => void;
  readonly editing: boolean;
} {
  const viewTabId = useEpicViewTabId();
  const visible = usePaneVisible();
  const editing = useCustomizeStore((state) => state.session !== null);
  const nodeRef = useRef<HTMLElement | null>(null);
  const registered = useRef<HotspotInstance | null>(null);
  const { settingId, tileId, ghost, condition } = input;
  const sync = useCallback(() => {
    const old = registered.current;
    const state = useCustomizeStore.getState();
    if (old) state.unregister(old.key, old.node);
    registered.current = null;
    if (!state.session || !nodeRef.current || !visible) return;
    const sceneId = viewTabId ?? "shell";
    const instance = {
      key: `${settingId}@${sceneId}:${tileId ?? "-"}`,
      settingId,
      sceneId,
      tileId,
      ghost,
      condition,
      node: nodeRef.current,
    };
    registered.current = instance;
    state.register(instance);
  }, [settingId, tileId, ghost, condition, viewTabId, visible]);
  const ref = useCallback(
    (node: HTMLElement | null) => {
      nodeRef.current = node;
      sync();
    },
    [sync],
  );
  useEffect(() => {
    sync();
    const unsubscribe = useCustomizeStore.subscribe((state, previous) => {
      if (state.session !== previous.session) sync();
    });
    return () => {
      unsubscribe();
      const old = registered.current;
      if (old) useCustomizeStore.getState().unregister(old.key, old.node);
      registered.current = null;
    };
  }, [sync]);
  return { ref, editing };
}
