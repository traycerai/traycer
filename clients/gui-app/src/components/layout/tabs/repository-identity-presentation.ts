import {
  Book,
  Box,
  Code,
  Cpu,
  Database,
  FlaskConical,
  Folder,
  Globe,
  Heart,
  Rocket,
  Sparkles,
  Terminal,
} from "lucide-react";
import type { WorkspaceAppearance } from "@traycer/protocol/host/workspace/appearance-schemas";
import type { TabIcon } from "@/stores/tabs/types";

type SymbolId = Extract<
  NonNullable<WorkspaceAppearance["icon"]>,
  { kind: "symbol" }
>["value"];

export const REPOSITORY_SYMBOL_ICONS: Record<SymbolId, TabIcon> = {
  folder: Folder,
  code: Code,
  terminal: Terminal,
  rocket: Rocket,
  globe: Globe,
  book: Book,
  box: Box,
  cpu: Cpu,
  database: Database,
  "flask-conical": FlaskConical,
  heart: Heart,
  sparkles: Sparkles,
};

export function repositoryTabFill(color: string | null | undefined): string {
  return color === null || color === undefined
    ? "var(--color-background)"
    : `color-mix(in srgb, ${color} 12%, var(--color-background))`;
}
