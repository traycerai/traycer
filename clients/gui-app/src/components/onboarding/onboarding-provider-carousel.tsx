import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  ProviderList,
  type ProviderListRow,
} from "@/components/providers/provider-list";
import { Button } from "@/components/ui/button";
import { horizontalScrollFadeClass } from "@/hooks/ui/use-horizontal-scroll-edges";
import { cn } from "@/lib/utils";

function providerPage(scroller: HTMLDivElement) {
  const list = scroller.querySelector("ul");
  const card = list?.firstElementChild;
  const gap =
    list === null
      ? 0
      : Number.parseFloat(getComputedStyle(list).columnGap) || 0;
  const stride = (card?.getBoundingClientRect().width ?? 0) + gap;
  const columns = Math.max(
    1,
    Math.floor((scroller.clientWidth + gap) / stride),
  );
  const step = Math.max(1, columns * stride || scroller.clientWidth);
  const overflow = scroller.scrollWidth - scroller.clientWidth;
  const maxScroll = overflow > 1 ? overflow : 0;
  const pages = Math.ceil(maxScroll / step) + 1;
  const left = scroller.scrollLeft > 1;
  const right = scroller.scrollLeft < maxScroll - 1;
  const page = right
    ? Math.min(pages, Math.round(scroller.scrollLeft / step) + 1)
    : pages;
  return { page, pages, step, maxScroll, left, right };
}

export function OnboardingProviderCarousel(props: {
  readonly rows: readonly ProviderListRow[];
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [pagination, setPagination] = useState({
    page: 1,
    pages: 1,
    left: false,
    right: false,
  });

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    const update = () => {
      const next = providerPage(scroller);
      setPagination((previous) =>
        previous.page === next.page &&
        previous.pages === next.pages &&
        previous.left === next.left &&
        previous.right === next.right
          ? previous
          : next,
      );
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    if (scroller.firstElementChild !== null) {
      observer.observe(scroller.firstElementChild);
    }
    return () => {
      scroller.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [props.rows.length]);

  const movePage = (direction: number, animate: boolean) => {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    const { page, step, maxScroll } = providerPage(scroller);
    scroller.scrollTo({
      left: Math.max(0, Math.min(maxScroll, (page - 1 + direction) * step)),
      behavior:
        animate &&
        !window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "smooth"
          : "instant",
    });
  };

  return (
    <div className="onboarding-provider-carousel flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={scrollerRef}
        className={cn(
          "onboarding-provider-scroller no-scrollbar min-h-0 w-full flex-1 overflow-auto overscroll-contain",
          horizontalScrollFadeClass(pagination),
        )}
      >
        <ProviderList
          ariaLabel="Coding agent CLIs"
          variant="onboarding"
          rows={props.rows}
          className="onboarding-provider-cards w-full gap-4 p-1"
        />
      </div>
      <nav
        aria-label="Provider pages"
        aria-hidden={pagination.pages === 1}
        className={cn(
          "flex shrink-0 items-center justify-center gap-3 pt-4",
          pagination.pages === 1 && "invisible",
        )}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Previous providers"
          disabled={!pagination.left}
          onClick={(event) => movePage(-1, event.detail > 0)}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span
          role="status"
          className="text-xs tabular-nums text-muted-foreground"
          aria-label={`Provider page ${pagination.page} of ${pagination.pages}`}
        >
          {pagination.page} / {pagination.pages}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Next providers"
          disabled={!pagination.right}
          onClick={(event) => movePage(1, event.detail > 0)}
        >
          <ChevronRight className="size-4" />
        </Button>
      </nav>
    </div>
  );
}
