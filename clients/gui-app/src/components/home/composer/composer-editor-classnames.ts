import { cn } from "@/lib/utils";

/** Kept in its own leaf module (not `composer-body.tsx`) so the component file exports only components. */
export const COMPOSER_EDITOR_CLASSNAME = cn(
  "text-ui text-foreground placeholder:text-muted-foreground",
  "min-h-[2.5rem] w-full overflow-y-auto whitespace-pre-wrap wrap-break-word bg-transparent text-ui leading-relaxed text-foreground focus:outline-none",
);
