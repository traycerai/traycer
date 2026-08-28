import { useState } from "react";
import { Globe2 } from "lucide-react";
import { cn } from "@/lib/utils";

export function BrowserFavicon(props: {
  readonly faviconUrl: string | null;
  readonly isolated: boolean;
  readonly className: string;
}) {
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const showImage = props.faviconUrl !== null && loadedSrc === props.faviconUrl;

  return (
    <span
      className={cn(
        // `inline-block` so the sizing classes in `props.className` (e.g.
        // `size-4`) apply even when this span isn't itself a flex item - a
        // plain `<span>` ignores width/height while `display: inline`, which
        // is what collapsed this icon inside `MentionMenuItem`'s nested
        // `<span className="shrink-0">` wrapper. A flex-item consumer
        // (tab-strip, sidebar row) already blockifies the child regardless
        // of its own `display`, so this is a no-op there.
        "relative inline-block shrink-0",
        props.className,
        props.isolated && "rounded-sm ring-1 ring-amber-500/80",
      )}
    >
      {showImage ? null : (
        <Globe2 className="size-full text-muted-foreground" aria-hidden />
      )}
      {props.faviconUrl === null ? null : (
        <img
          src={props.faviconUrl}
          alt=""
          className={cn(
            "absolute inset-0 size-full rounded-sm ring-1 ring-black/10 dark:ring-white/10",
            showImage ? "opacity-100" : "opacity-0",
          )}
          onLoad={() => setLoadedSrc(props.faviconUrl)}
          onError={() =>
            setLoadedSrc((current) =>
              current === props.faviconUrl ? null : current,
            )
          }
        />
      )}
    </span>
  );
}
