import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import "@/index.css";

export function ToastTwoActionsFixture(): React.ReactElement {
  useEffect(() => {
    const buttons = new URLSearchParams(window.location.search).get("buttons");
    if (buttons === "2") {
      toast("Move this computer to Personal", {
        description:
          "So your settings follow you to every computer and sandbox.",
        cancel: { label: "Not now", onClick: () => undefined },
        action: { label: "Move to Personal", onClick: () => undefined },
        duration: Infinity,
      });
      return;
    }

    toast("You're all set", {
      description: "More setup is in Settings.",
      action: { label: "Open", onClick: () => undefined },
      duration: Infinity,
    });
  }, []);

  return <Toaster />;
}

const container = document.querySelector("#root");
if (container === null) throw new Error("probe root missing");
createRoot(container).render(<ToastTwoActionsFixture />);
