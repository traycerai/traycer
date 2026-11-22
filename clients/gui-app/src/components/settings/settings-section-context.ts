import { createContext } from "react";
import type { SettingsSectionId } from "@/lib/settings-sections";

/** The section this panel renders, including restored and split Settings tabs. */
export const SettingsSectionContext = createContext<SettingsSectionId | null>(
  null,
);
