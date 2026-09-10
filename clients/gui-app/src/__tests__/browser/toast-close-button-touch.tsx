import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { setMobileApp } from "@/lib/mobile-app";
import "@/index.css";

/**
 * Real-layout fixture for the toaster's touch behaviour: whether the close
 * button is visible and tappable under sonner's touch media query, and where
 * the toaster sits in the installed mobile app.
 *
 * jsdom evaluates no media queries and has no hit testing, so it can only
 * check which class names are applied; this renders the real `Toaster`
 * against the real stylesheet so the driver can read computed styles and
 * `elementFromPoint` while Chrome's touch emulation flips the query.
 *
 * `?mobile-app=1` marks the page as the installed mobile app before the first
 * render, the same way the phone entry does.
 */
export function ToastCloseButtonTouchFixture(): React.ReactElement {
  useEffect(() => {
    toast("Worktree deleted", {
      id: "probe-toast",
      description: "Swipe, wait, or tap the close button.",
      duration: Infinity,
    });
  }, []);

  return <Toaster />;
}

setMobileApp(
  new URLSearchParams(window.location.search).get("mobile-app") === "1",
);
const container = document.querySelector("#root");
if (container === null) throw new Error("probe root missing");
createRoot(container).render(<ToastCloseButtonTouchFixture />);
