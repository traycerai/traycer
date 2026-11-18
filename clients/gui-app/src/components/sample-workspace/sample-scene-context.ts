import { createContext, useContext } from "react";
export const SampleSceneContext = createContext(false);
export function useSampleScene(): boolean {
  return useContext(SampleSceneContext);
}
