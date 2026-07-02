import { memo } from "react";

import { cn } from "@/lib/utils";
import {
  composerInlineChipClassNames,
  type ComposerInlineChipDensity,
} from "./composer-inline-chip-classnames";

interface SlashCommandChipProps {
  readonly name: string;
  readonly density: ComposerInlineChipDensity;
}

function SlashCommandChipBase({ density, name }: SlashCommandChipProps) {
  const classNames = composerInlineChipClassNames(density);
  return (
    <span
      className={cn(classNames.root, "font-mono text-foreground")}
      data-composer-chip="slash-command"
    >
      <span className={classNames.text}>{name}</span>
    </span>
  );
}

export const SlashCommandChip = memo(SlashCommandChipBase);
