import { useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/**
 * A toast body with one primary action and "Later": the app-update toasts'
 * shape, shared with the feature announcements so a second toast with a
 * button does not grow a second button layout.
 *
 * The primary action fires once. A toast dismisses on a delay, so a second
 * click can land while it is on its way out; the ref (not only the state)
 * is what makes the guard hold inside the same tick. Either button dismisses
 * the toast by the id its caller shows it under.
 */
export function ActionToastContent(props: {
  readonly toastId: string;
  /** A small uppercase line above the title, or `null` for none. */
  readonly eyebrow: string | null;
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
  readonly onAction: () => void;
  readonly onLater: (() => void) | null;
}): ReactNode {
  const actionHandledRef = useRef(false);
  const [actionHandled, setActionHandled] = useState(false);

  function handleAction(): void {
    if (actionHandledRef.current) return;
    actionHandledRef.current = true;
    setActionHandled(true);
    toast.dismiss(props.toastId);
    props.onAction();
  }

  return (
    <div className="flex items-center gap-4">
      <div className="min-w-0 flex-1">
        {props.eyebrow === null ? null : (
          <div className="mb-1 font-mono text-ui-xs tracking-[0.07em] text-muted-foreground uppercase">
            {props.eyebrow}
          </div>
        )}
        <div className="font-medium">{props.title}</div>
        <div className="mt-1 text-muted-foreground">{props.description}</div>
      </div>
      <div className="grid shrink-0 grid-cols-1 gap-1.5">
        <Button
          type="button"
          size="sm"
          className="w-full min-w-max"
          disabled={actionHandled}
          onClick={handleAction}
        >
          {props.actionLabel}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="w-full min-w-max"
          onClick={() => {
            toast.dismiss(props.toastId);
            props.onLater?.();
          }}
        >
          Later
        </Button>
      </div>
    </div>
  );
}
