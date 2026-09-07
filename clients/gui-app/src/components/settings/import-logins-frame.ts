import type { ComponentType, ReactNode } from "react";
import {
  PlainImportLoginsDescription,
  PlainImportLoginsFooter,
  PlainImportLoginsHeader,
  PlainImportLoginsTitle,
} from "@/components/settings/import-logins-plain-frame";

/** What a surface renders an `ImportLoginsFlow` step's chrome with: the header, title, description and footer. */
export interface ImportLoginsFrame {
  readonly Header: ComponentType<{ readonly children: ReactNode }>;
  readonly Title: ComponentType<{ readonly children: ReactNode }>;
  readonly Description: ComponentType<{ readonly children: ReactNode }>;
  readonly Footer: ComponentType<{ readonly children: ReactNode }>;
}

export const PLAIN_IMPORT_LOGINS_FRAME: ImportLoginsFrame = {
  Header: PlainImportLoginsHeader,
  Title: PlainImportLoginsTitle,
  Description: PlainImportLoginsDescription,
  Footer: PlainImportLoginsFooter,
};
