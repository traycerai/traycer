import type { ThemeRegistration } from "shiki/core";
import { getActiveThemeDefinition } from "@/lib/theme-applier";
import { contentFingerprint } from "@/lib/text-hash";
import type { ThemeDefinition } from "@/lib/themes/theme-definition";

const registrations = new WeakMap<ThemeDefinition, ThemeRegistration>();

/** One content-addressed syntax identity for markdown and the diff workers. */
export function getActiveSyntaxTheme(): ThemeRegistration | null {
  const theme = getActiveThemeDefinition();
  if (theme === null || theme.syntax === null) return null;
  const cached = registrations.get(theme);
  if (cached !== undefined) return cached;
  const registration: ThemeRegistration = {
    ...theme.syntax,
    name: `traycer-${contentFingerprint(JSON.stringify([theme.appearance, theme.syntax]))}`,
    type: theme.appearance,
  };
  registrations.set(theme, registration);
  return registration;
}
