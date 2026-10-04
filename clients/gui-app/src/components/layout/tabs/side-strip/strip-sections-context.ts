import { createContext } from "react";
import type { StripSectionGroup } from "./strip-sections";

/** The strip's sections, as `StripSectionsScope` reads them once for its rows. */
export const StripSectionsContext = createContext<
  ReadonlyArray<StripSectionGroup>
>([]);
