import { useEffect, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { domMax, LazyMotion } from "motion/react";
import { MobileNavDrawerSurface } from "@/components/layout/shell/mobile-nav-drawer-surface";
import "@/index.css";

/**
 * THE MOBILE NAV DRAWER'S SURFACE ON A SCREEN WITH A LEFT INSET.
 *
 * The real `MobileNavDrawerSurface` with a line of content, opened and closed
 * through `window.__drawerProbe`. The spec sets `--safe-area-inset-left` on
 * the document element, the one property `index.css` reads the inset through,
 * to stand in for the notch a landscape phone turns toward the left edge.
 */
declare global {
  interface Window {
    __drawerProbe?: { readonly setOpen: (open: boolean) => void };
  }
}

export function Drawer(): ReactElement {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    window.__drawerProbe = { setOpen };
  }, []);
  return (
    <LazyMotion features={domMax}>
      <MobileNavDrawerSurface open={open} onOpenChange={setOpen}>
        <div>Menu</div>
      </MobileNavDrawerSurface>
    </LazyMotion>
  );
}

const root = document.querySelector("#root");
if (root === null)
  throw new Error("mobile nav drawer inset fixture root missing");
createRoot(root).render(<Drawer />);
