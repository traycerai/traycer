import { createContext, useContext } from "react";

/**
 * The id of the enclosing `SettingsRow`'s description `<p>`, or `undefined`
 * when the row has no description (or the control is not inside a row at all).
 *
 * A context rather than a `control` render prop: the control reaches
 * `SettingsRow` as an already-built `ReactNode`, so the row cannot reach into
 * it, and a function prop returning JSX reads as a component definition during
 * render to `react/no-unstable-nested-components`. Reading the id from below
 * leaves every existing call site untouched.
 *
 * It lives beside `settings-row.tsx` rather than inside it so that file keeps
 * exporting only a component (fast refresh), the same split
 * `settings-row-layout.ts` already makes.
 */
export const SettingsRowDescriptionContext = createContext<string | undefined>(
  undefined,
);

/**
 * For a control that wants `aria-describedby` pointing at its row's
 * description - pass the result straight through; `undefined` drops the
 * attribute rather than pointing it at nothing.
 */
export function useSettingsRowDescriptionId(): string | undefined {
  return useContext(SettingsRowDescriptionContext);
}
