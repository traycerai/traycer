import { type ReactNode } from "react";
import {
  ResolvedThemeContext,
  type ResolvedThemeContextValue,
} from "@/providers/use-resolved-theme";

const THEME: ResolvedThemeContextValue = {
  resolvedTheme: "light",
  themePreset: "neutral",
};

/** The shared sheet reads the resolved theme. The team page harness does not provide one. */
export function PhoneTheme(props: { readonly children: ReactNode }): ReactNode {
  return (
    <ResolvedThemeContext.Provider value={THEME}>
      {props.children}
    </ResolvedThemeContext.Provider>
  );
}
