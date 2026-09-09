import type { ComponentType, ReactNode } from "react";
import {
  PlainImportLoginsDescription,
  PlainImportLoginsFooter,
  PlainImportLoginsHeader,
  PlainImportLoginsTitle,
} from "@/components/settings/import-logins-plain-frame";

/**
 * What a surface renders an `ImportLoginsFlow` step's chrome with: the
 * header, title, description and footer. The dialog supplies its Radix parts,
 * which throw outside a `Dialog`; a surface with no dialog - the tour's stage
 * - supplies {@link PLAIN_IMPORT_LOGINS_FRAME}.
 */
export interface ImportLoginsFrame {
  readonly Header: ComponentType<{ readonly children: ReactNode }>;
  readonly Title: ComponentType<{ readonly children: ReactNode }>;
  readonly Description: ComponentType<{ readonly children: ReactNode }>;
  readonly Footer: ComponentType<{ readonly children: ReactNode }>;
}

/** Plain elements for a surface with no dialog. */
export const PLAIN_IMPORT_LOGINS_FRAME: ImportLoginsFrame = {
  Header: PlainImportLoginsHeader,
  Title: PlainImportLoginsTitle,
  Description: PlainImportLoginsDescription,
  Footer: PlainImportLoginsFooter,
};
