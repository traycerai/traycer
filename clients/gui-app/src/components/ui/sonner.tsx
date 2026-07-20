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
  "hover:bg-muted",
);
const INTERACTIVE_ELEMENT_SELECTOR =
  "button, a, input, textarea, select, [role='button']";
const NOTIFICATION_TOAST_ACTION_SELECTOR = "[data-notification-toast-action]";

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();
  const toasterTheme = normalizeToasterTheme(theme);

  return (
    <DismissableLayer.Branch
      data-slot="toaster-branch"
      onClick={activateNotificationToastSurface}
    >
      <Sonner
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
