import { createContext, use } from "react";
import { create } from "zustand";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import { useTabBodySelected } from "@/components/epic-canvas/canvas/tab-body-selected-context";

export type ActiveSurfaceDemand = "preview" | "settled";
export type SurfaceDemand = ActiveSurfaceDemand | null;

interface SurfaceDemandState {
  readonly topLevelActiveKeys: ReadonlyArray<string> | null;
  readonly topLevelPreviewKeys: ReadonlyArray<string>;
  readonly panePreviewTargets: Readonly<Record<string, string | undefined>>;
}

// Activation owns these transient selections. They are never persisted or
// inferred from input devices; an ordinary activation settles its surface.
export const useSurfaceDemandStore = create<SurfaceDemandState>(() => ({
  topLevelActiveKeys: null,
  topLevelPreviewKeys: [],
  panePreviewTargets: {},
}));

export function setTopLevelDemand(
  keys: ReadonlyArray<string>,
  demand: ActiveSurfaceDemand,
): void {
  useSurfaceDemandStore.setState({
    topLevelActiveKeys: keys,
    topLevelPreviewKeys: demand === "preview" ? keys : [],
  });
}

export function setPaneDemand(
  paneId: string,
  instanceId: string,
  demand: ActiveSurfaceDemand,
): void {
  useSurfaceDemandStore.setState((state) => {
    const panePreviewTargets = { ...state.panePreviewTargets };
    if (demand === "preview") panePreviewTargets[paneId] = instanceId;
    else delete panePreviewTargets[paneId];
    return { panePreviewTargets };
  });
}

export function topLevelDemand(key: string): SurfaceDemand {
  const state = useSurfaceDemandStore.getState();
  if (
    state.topLevelActiveKeys !== null &&
    !state.topLevelActiveKeys.includes(key)
  )
    return null;
  return state.topLevelPreviewKeys.includes(key) ? "preview" : "settled";
}

export function paneDemand(paneId: string): ActiveSurfaceDemand {
  return useSurfaceDemandStore.getState().panePreviewTargets[paneId] !==
    undefined
    ? "preview"
    : "settled";
}

export function hasPreviewDemand(): boolean {
  const state = useSurfaceDemandStore.getState();
  return (
    state.topLevelPreviewKeys.length > 0 ||
    Object.keys(state.panePreviewTargets).length > 0
  );
}

export const SurfaceDemandContext =
  createContext<ActiveSurfaceDemand>("settled");

export function useSurfaceDemand(): SurfaceDemand {
  const demand = use(SurfaceDemandContext);
  const visible = usePaneVisible();
  const selected = useTabBodySelected();
  return visible && selected ? demand : null;
}

export function cancelPanePreview(paneId: string, instanceId: string): void {
  if (
    useSurfaceDemandStore.getState().panePreviewTargets[paneId] === instanceId
  ) {
    setPaneDemand(paneId, instanceId, "settled");
  }
}
