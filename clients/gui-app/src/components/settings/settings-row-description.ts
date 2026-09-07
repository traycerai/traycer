import { createContext, useContext } from "react";

/** A context rather than a `control` render prop. */
export const SettingsRowDescriptionContext = createContext<string | undefined>(
  undefined,
);

/** For a control that wants `aria-describedby` pointing at its row's description - pass the result straight
 * through; `undefined` drops the attribute rather than pointing it at nothing. */
export function useSettingsRowDescriptionId(): string | undefined {
  return useContext(SettingsRowDescriptionContext);
}
