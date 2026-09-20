import "./customize.css";
import { AnimatePresence, m, useIsPresent } from "motion/react";
import { usePanelAnimationDuration } from "@/hooks/use-panel-animation-duration";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { CustomizeScrim } from "@/components/customize/customize-scrim";
import { CustomizeProxies } from "@/components/customize/customize-proxies";
import { useHotspotRects } from "@/components/customize/use-hotspot-rects";
import { useCustomizeInert } from "@/components/customize/use-customize-inert";
import { CustomizeBar } from "@/components/customize/customize-bar";
import { CustomizePopover } from "@/components/customize/customize-popover";
import {
  CustomizeDnd,
  CustomizeDropTarget,
} from "@/components/customize/customize-dnd";
import {
  exitCustomize,
  setCustomizeInputMethod,
  isCustomizePointerInput,
} from "@/lib/customize/enter-exit";
import {
  findCustomizeProxy,
  focusCustomizeInvoker,
} from "@/lib/customize/focus";
import { handleCustomizeKeydown } from "@/lib/customize/keyboard";
import {
  initializeCustomizeWindow,
  watchCustomizeLease,
} from "@/lib/customize/lease";
import { getCustomizeSetting } from "@/lib/customize/catalog";
import { registerBuiltinCustomizeOptions } from "@/lib/customize/options";
import { useDesktopWindowId } from "@/lib/windows/desktop-window-id";
import {
  selectedInstances,
  useCustomizeStore,
} from "@/stores/customize/customize-store";

registerBuiltinCustomizeOptions();

export function CustomizeOverlay() {
  const session = useCustomizeStore((state) => state.session);
  const windowId = useDesktopWindowId();
  useEffect(() => {
    initializeCustomizeWindow(windowId);
    const pointer = () => setCustomizeInputMethod(true);
    const keyboard = () => setCustomizeInputMethod(false);
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("keydown", keyboard, true);
    const unwatch = watchCustomizeLease(() => exitCustomize("lease-lost"));
    const unload = () => exitCustomize("studio-closed");
    window.addEventListener("pagehide", unload);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("keydown", keyboard, true);
      unwatch();
      window.removeEventListener("pagehide", unload);
      exitCustomize("studio-closed");
    };
  }, [windowId]);
  return createPortal(
    <AnimatePresence>
      {session ? (
        <LiveOverlay
          key={session.startedAt}
          pointerEntry={session.pointerEntry === true}
        />
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
function LiveOverlay({ pointerEntry }: { pointerEntry: boolean }) {
  const present = useIsPresent();
  useCustomizeInert(present);
  const duration = usePanelAnimationDuration();
  const instances = useCustomizeStore((state) => state.instances);
  const preferredTileId = useCustomizeStore((state) => state.preferredTileId);
  const selected = useMemo(
    () => selectedInstances({ instances, preferredTileId }),
    [instances, preferredTileId],
  );
  const measurements = useHotspotRects(instances);
  const previous = useRef(selected);
  useLayoutEffect(() => {
    if (measurements.source !== instances) return;
    const state = useCustomizeStore.getState();
    const pending = selected.find(
      (instance) =>
        instance.settingId === state.pendingTarget &&
        measurements.rects.has(instance.key),
    );
    if (pending) {
      state.openPopover(pending.key, "search", null);
      useCustomizeStore.setState({ pendingTarget: null });
    }
    const key = state.popoverKey ?? state.activeKey;
    if (key && (!instances.has(key) || measurements.unreachable.has(key))) {
      const old = previous.current.find((instance) => instance.key === key);
      state.closePopover();
      state.setActive(null);
      if (old)
        state.announce(
          `${getCustomizeSetting(old.settingId).label} is no longer on screen`,
        );
      const remaining = selected.filter((instance) =>
        measurements.rects.has(instance.key),
      );
      const nearest = remaining.at(
        Math.min(
          Math.max(
            0,
            previous.current.findIndex((instance) => instance.key === key),
          ),
          remaining.length - 1,
        ),
      );
      if (
        state.invoker === "search" ||
        document.activeElement?.matches("[data-customize-search]")
      )
        focusCustomizeInvoker();
      else if (nearest)
        findCustomizeProxy(nearest.key)?.focus({ preventScroll: true });
      else focusCustomizeInvoker();
    }
    previous.current = selected;
  }, [instances, selected, measurements]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const { popoverKey, activeKey } = useCustomizeStore.getState();
      if (!popoverKey && !activeKey)
        document
          .querySelector<HTMLInputElement>("[data-customize-search]")
          ?.focus();
    });
    const outside = (event: MouseEvent) => {
      if (
        event.target instanceof Element &&
        !event.target.closest(
          "[data-customize-editor], [data-slot='popover-content'], [data-slot='dropdown-menu-content']",
        )
      )
        useCustomizeStore.getState().closePopover();
    };
    document.addEventListener("keydown", handleCustomizeKeydown, true);
    document.addEventListener("click", outside, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleCustomizeKeydown, true);
      document.removeEventListener("click", outside, true);
    };
  }, []);
  return (
    <div
      inert={!present}
      aria-hidden={!present}
      data-customize-editor
      className="pointer-events-none fixed inset-0 z-40"
    >
      <m.div
        initial={{ opacity: pointerEntry && duration > 0 ? 0 : 1 }}
        animate={{ opacity: 1 }}
        exit={{
          opacity: 0,
          transition: {
            duration: isCustomizePointerInput() && duration > 0 ? 0.125 : 0,
          },
        }}
        transition={{
          duration: pointerEntry && duration > 0 ? 0.2 : 0,
          ease: [0.23, 1, 0.32, 1],
        }}
      >
        <CustomizeScrim
          instances={selected}
          rects={measurements.rects}
          closePopover={() => useCustomizeStore.getState().closePopover()}
        />
      </m.div>
      <CustomizeDnd>
        {measurements.slots
          .filter(
            (slot) =>
              slot.tileId === null ||
              selected.some((instance) => instance.tileId === slot.tileId),
          )
          .map((slot) => (
            <CustomizeDropTarget key={slot.id} slot={slot} />
          ))}
        <CustomizeProxies instances={selected} rects={measurements.hitRects} />
      </CustomizeDnd>
      <CustomizePopover rects={measurements.rects} />
      <CustomizeBar unreachable={measurements.unreachable} />
    </div>
  );
}
