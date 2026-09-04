import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { DismissableLayer } from "radix-ui/internal";
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
} from "lucide-react";
import { ProgressToastIcon } from "@/components/ui/progress-toast-icon";
import { cn } from "@/lib/utils";
import {
  listTileRects,
  subscribeTileRects,
} from "@/lib/browser-view/tiles/tile-rect-registry";
import {
  DEFAULT_TOASTER_ANCHOR,
  pickToasterAnchor,
  type ToasterAnchor,
  type ToasterSize,
} from "@/components/ui/toaster-anchor";

const TOAST_CLASS_NAME = cn("cn-toast", "group/toast");
const TOAST_CLOSE_BUTTON_CLASS_NAME = cn(
  "pointer-events-none",
  "opacity-0",
  "group-hover/toast:pointer-events-auto",
  "group-hover/toast:opacity-100",
  "group-focus-within/toast:pointer-events-auto",
  "group-focus-within/toast:opacity-100",
  "focus-visible:pointer-events-auto",
  "focus-visible:opacity-100",
);
const TOAST_CANCEL_BUTTON_CLASS_NAME = cn(
  "border border-border bg-background text-foreground",
  // Not `hover:bg-muted`: the button is `bg-background`, and the five flat
  // light presets define `--muted` as exactly that, so the hover was a no-op
  // there. The fill IS the whole state change here - the border is static.
  "hover:bg-foreground/5",
);
const INTERACTIVE_ELEMENT_SELECTOR =
  "button, a, input, textarea, select, [role='button']";
const NOTIFICATION_TOAST_ACTION_SELECTOR = "[data-notification-toast-action]";
// The outer `<section>` sonner renders is a static, zero-height wrapper -
// the fixed, painted surface is one `<ol data-sonner-toaster>` per toast
// position, and sonner (2.0.8) mounts each only once a toast exists for
// that position. Size is measured from those lists so toast placement can
// prefer anchors that miss live browser tiles.
const SONNER_TOASTER_LIST_SELECTOR = "[data-sonner-toaster]";

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();
  const toasterTheme = normalizeToasterTheme(theme);
  const sectionRef = useRef<HTMLElement | null>(null);
  // Sonner mounts the `<ol>` only while a toast exists (see the selector
  // comment above), so this is also the "is a toast currently visible" flag
  // - `recomputeAnchor` reads it to honor invariant 10's other half:
  // don't re-anchor a toaster a toast is already showing on.
  const toastVisibleRef = useRef(false);
  // The toaster's own last-measured rect, cached across the `<ol>` mounting
  // and unmounting so a prospective anchor rect never has to hardcode a
  // size - see `toaster-anchor.ts`.
  const toasterSizeRef = useRef<ToasterSize | null>(null);
  const [anchor, setAnchor] = useState<ToasterAnchor>(DEFAULT_TOASTER_ANCHOR);

  const recomputeAnchor = useCallback(() => {
    if (toastVisibleRef.current) return;
    setAnchor(
      pickToasterAnchor({
        toasterSize: toasterSizeRef.current,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        tileRects: listTileRects(),
      }),
    );
  }, []);

  useEffect(() => {
    const section = sectionRef.current;
    if (section === null) return;
    const sync = (): void => {
      const first = section.querySelector<HTMLElement>(
        SONNER_TOASTER_LIST_SELECTOR,
      );
      if (first !== null) {
        const rect = first.getBoundingClientRect();
        toasterSizeRef.current = { width: rect.width, height: rect.height };
      }
      toastVisibleRef.current = first !== null;
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(section, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => subscribeTileRects(recomputeAnchor), [recomputeAnchor]);

  return (
    <DismissableLayer.Branch
      data-slot="toaster-branch"
      onClick={activateNotificationToastSurface}
    >
      <Sonner
        ref={sectionRef}
        theme={toasterTheme}
        className="toaster group"
        icons={{
          success: <CircleCheckIcon className="size-4" />,
          info: <InfoIcon className="size-4" />,
          warning: <TriangleAlertIcon className="size-4" />,
          error: <OctagonXIcon className="size-4" />,
          loading: <ProgressToastIcon />,
        }}
        style={
          {
            "--normal-bg": "var(--popover)",
            "--normal-text": "var(--popover-foreground)",
            "--normal-border": "var(--border)",
            "--border-radius": "var(--radius)",
          } as React.CSSProperties
        }
        toastOptions={{
          classNames: {
            toast: TOAST_CLASS_NAME,
            closeButton: TOAST_CLOSE_BUTTON_CLASS_NAME,
            cancelButton: TOAST_CANCEL_BUTTON_CLASS_NAME,
          },
        }}
        {...props}
        closeButton={props.closeButton ?? true}
        position={props.position ?? anchor}
      />
    </DismissableLayer.Branch>
  );
};

function activateNotificationToastSurface(
  event: React.MouseEvent<HTMLDivElement>,
): void {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const interactiveTarget = target.closest(INTERACTIVE_ELEMENT_SELECTOR);
  const toastSurface = target.closest("[data-sonner-toast]");
  const action = toastSurface?.querySelector<HTMLButtonElement>(
    NOTIFICATION_TOAST_ACTION_SELECTOR,
  );
  if (interactiveTarget !== null) return;

  if (action === undefined || action === null) return;
  action.click();
}

function normalizeToasterTheme(
  theme: string | undefined,
): ToasterProps["theme"] {
  if (isValidToasterTheme(theme)) return theme;
  return "system";
}

function isValidToasterTheme(
  theme: string | undefined,
): theme is "light" | "dark" | "system" {
  return theme === "light" || theme === "dark" || theme === "system";
}

export { Toaster };
