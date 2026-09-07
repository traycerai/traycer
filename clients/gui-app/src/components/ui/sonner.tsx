import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { DismissableLayer, useComposedRefs } from "radix-ui/internal";
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
} from "lucide-react";
import { ProgressToastIcon } from "@/components/ui/progress-toast-icon";
import { cn } from "@/lib/utils";
import {
  listBrowserOverlayTiles,
  registerBrowserOverlay,
  subscribeBrowserOverlayLayout,
} from "@/lib/browser-view/tiles/browser-overlay-coordinator";
import { useRegisterBrowserOverlay } from "@/lib/browser-view/tiles/use-register-browser-overlay";
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
// that position. The section itself is worth registering too (it is what
// `Sonner`'s own `ref` forwards to, and a stable anchor costs nothing), but
// occlusion has to track the `<ol>`s, which come and go independently.
const SONNER_TOASTER_LIST_SELECTOR = "[data-sonner-toaster]";

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();
  const toasterTheme = normalizeToasterTheme(theme);
  const sectionRef = useRef<HTMLElement | null>(null);
  const registerSectionOverlayRef = useRegisterBrowserOverlay<HTMLElement>();
  const composedRef = useComposedRefs(sectionRef, registerSectionOverlayRef);
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
        tileRects: listBrowserOverlayTiles().map((tile) => tile.rect),
      }),
    );
  }, []);

  useEffect(() => {
    const section = sectionRef.current;
    if (section === null) return;
    const deregisterByList = new Map<Element, () => void>();
    const sync = (): void => {
      const lists = section.querySelectorAll<HTMLElement>(
        SONNER_TOASTER_LIST_SELECTOR,
      );
      const seen = new Set<Element>(lists);
      deregisterByList.forEach((deregister, element) => {
        if (seen.has(element)) return;
        deregister();
        deregisterByList.delete(element);
      });
      lists.forEach((element) => {
        const rect = element.getBoundingClientRect();
        toasterSizeRef.current = { width: rect.width, height: rect.height };
        if (deregisterByList.has(element)) return;
        deregisterByList.set(element, registerBrowserOverlay({ element }));
      });
      toastVisibleRef.current = lists.length > 0;
    };
    sync();
    const observer = new MutationObserver(sync);
    // `subtree`, not just the section's own children: a toast added to an
    // ALREADY-mounted `<ol>` is a mutation inside it, not of the section, so
    // a childList-only observer would keep the first measured size and let
    // `pickToasterAnchor` compare a rect the grown toaster has outgrown.
    observer.observe(section, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      deregisterByList.forEach((deregister) => deregister());
      deregisterByList.clear();
    };
  }, []);

  useEffect(
    () => subscribeBrowserOverlayLayout(recomputeAnchor),
    [recomputeAnchor],
  );

  return (
    <DismissableLayer.Branch
      data-slot="toaster-branch"
      onClick={activateNotificationToastSurface}
    >
      <Sonner
        ref={composedRef}
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
