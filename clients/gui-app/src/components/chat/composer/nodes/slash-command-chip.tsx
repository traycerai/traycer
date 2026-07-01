import { memo } from "react";

import { cn } from "@/lib/utils";
import {
  COMPOSER_INLINE_CHIP_CLASSNAME,
  COMPOSER_INLINE_CHIP_TEXT_CLASSNAME,
} from "./composer-inline-chip-classnames";

interface SlashCommandChipProps {
  readonly name: string;
  readonly className?: string;
  readonly textClassName?: string;
}

function SlashCommandChipBase({
  className,
  name,
  textClassName,
}: SlashCommandChipProps) {
  return (
    <span
      className={cn(
        className ?? COMPOSER_INLINE_CHIP_CLASSNAME,
        "font-mono text-foreground",
      )}
      data-composer-chip="slash-command"
    >
      <span className={textClassName ?? COMPOSER_INLINE_CHIP_TEXT_CLASSNAME}>
        {name}
      </span>
    </span>
  );
}

export const SlashCommandChip = memo(SlashCommandChipBase);
