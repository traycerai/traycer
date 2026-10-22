/** Runs inside plain HTML artifacts, never canvas boards or MCP Apps. */
function htmlViewerBootstrap(): void {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;
  const host = window.parent;
  let scale = 1;
  let zoomEnabled = false;
  let bodyZoom = 1;
  let pendingFrame = 0;
  let fadeTimer = 0;
  let dragging = false;
  let hovering = false;
  let overlay: HTMLElement | null = null;
  let vertical: HTMLButtonElement | null = null;
  let horizontal: HTMLButtonElement | null = null;

  const notifyZoom = (): void => {
    host.postMessage(
      {
        jsonrpc: "2.0",
        method: "traycer/notifications/html-view",
        params: { scale },
      },
      "*",
    );
  };
  const showScrollbars = (): void => {
    overlay?.setAttribute("data-active", "");
    window.clearTimeout(fadeTimer);
    fadeTimer = window.setTimeout(() => {
      if (dragging || hovering) return;
      overlay?.removeAttribute("data-active");
    }, 1000);
  };
  const updateScrollbars = (): void => {
    pendingFrame = 0;
    const root = document.scrollingElement;
    if (root === null || vertical === null || horizontal === null) return;
    for (const [button, isVertical] of [
      [vertical, true],
      [horizontal, false],
    ] as const) {
      const viewport = isVertical ? window.innerHeight : window.innerWidth;
      const extent = isVertical ? root.scrollHeight : root.scrollWidth;
      const position = isVertical ? root.scrollTop : root.scrollLeft;
      const track = Math.max(0, viewport - 12);
      const length = Math.min(track, Math.max(28, (viewport / extent) * track));
      const offset =
        extent <= viewport
          ? 0
          : (position / (extent - viewport)) * (track - length);
      button.hidden = extent <= viewport + 1;
      button.style[isVertical ? "height" : "width"] = `${length}px`;
      button.style.transform = isVertical
        ? `translateY(${offset}px)`
        : `translateX(${offset}px)`;
      button.setAttribute(
        "aria-valuemax",
        String(Math.max(0, extent - viewport)),
      );
      button.setAttribute("aria-valuenow", String(Math.round(position)));
    }
  };
  const scheduleScrollbars = (): void => {
    if (pendingFrame === 0)
      pendingFrame = window.requestAnimationFrame(updateScrollbars);
  };
  const setScale = (next: number, clientX: number, clientY: number): void => {
    const body = document.querySelector("body");
    if (body === null) return;
    const target = Math.max(0.25, Math.min(4, next));
    if (target === scale) return;
    const ratio = target / scale;
    const left = (window.scrollX + clientX) * ratio - clientX;
    const top = (window.scrollY + clientY) * ratio - clientY;
    scale = target;
    body.style.zoom = String(bodyZoom * scale);
    window.scrollTo({ left, top, behavior: "instant" });
    scheduleScrollbars();
    showScrollbars();
    notifyZoom();
  };
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== host || !isRecord(event.data)) return;
    const data = event.data;
    if (data.method !== "traycer/html/view" || !isRecord(data.params)) return;
    const params = data.params;
    zoomEnabled = params.enabled === true;
    if (typeof params.scale === "number" && Number.isFinite(params.scale)) {
      setScale(params.scale, window.innerWidth / 2, window.innerHeight / 2);
    }
    notifyZoom();
  });
  window.addEventListener(
    "wheel",
    (event) => {
      if (!zoomEnabled || !event.ctrlKey || event.defaultPrevented) return;
      event.preventDefault();
      // Trackpad pinch arrives as fine-grained Ctrl-wheel on Chromium.
      let unit = 1;
      if (event.deltaMode === 1) unit = 16;
      else if (event.deltaMode === 2) unit = window.innerHeight;
      const pixels = event.deltaY * unit;
      setScale(scale * Math.exp(-pixels * 0.005), event.clientX, event.clientY);
    },
    { passive: false },
  );

  let pinch: { distance: number; scale: number; x: number; y: number } | null =
    null;
  const touchGeometry = (touches: TouchList) => {
    const first = touches.item(0);
    const second = touches.item(1);
    if (touches.length !== 2 || first === null || second === null) return null;
    return {
      distance: Math.max(
        1,
        Math.hypot(
          first.clientX - second.clientX,
          first.clientY - second.clientY,
        ),
      ),
      x: (first.clientX + second.clientX) / 2,
      y: (first.clientY + second.clientY) / 2,
    };
  };
  window.addEventListener(
    "touchstart",
    (event) => {
      const geometry = zoomEnabled ? touchGeometry(event.touches) : null;
      pinch = geometry === null ? null : { ...geometry, scale };
    },
    { passive: true },
  );
  window.addEventListener(
    "touchmove",
    (event) => {
      const geometry = touchGeometry(event.touches);
      if (!zoomEnabled || pinch === null || geometry === null) return;
      if (event.cancelable) event.preventDefault();
      setScale(
        (pinch.scale * geometry.distance) / pinch.distance,
        geometry.x,
        geometry.y,
      );
      window.scrollBy({
        left: pinch.x - geometry.x,
        top: pinch.y - geometry.y,
        behavior: "instant",
      });
      pinch = { ...pinch, x: geometry.x, y: geometry.y };
    },
    { passive: false },
  );
  const endPinch = (): void => {
    pinch = null;
  };
  window.addEventListener("touchend", endPinch, { passive: true });
  window.addEventListener("touchcancel", endPinch, { passive: true });

  document.addEventListener(
    "DOMContentLoaded",
    () => {
      const body = document.querySelector("body");
      bodyZoom =
        body === null ? 1 : Number.parseFloat(getComputedStyle(body).zoom) || 1;
      const style = document.createElement("style");
      style.textContent = `
      :root { scrollbar-width: none; --traycer-scrollbar-thumb: transparent; }
      :root::-webkit-scrollbar { display: none; }
      :where(body, body *) { scrollbar-width: thin; scrollbar-color: var(--traycer-scrollbar-thumb) transparent; }
      :where(body, body *)::-webkit-scrollbar { width: 4px; height: 4px; }
      :where(body, body *)::-webkit-scrollbar-track { background: transparent; }
      :where(body, body *)::-webkit-scrollbar-thumb { background: var(--traycer-scrollbar-thumb); border-radius: 4px; }
      :where(body, body *)::-webkit-scrollbar-corner { background: transparent; }
    `;
      document.head.appendChild(style);
      overlay = document.createElement("div");
      overlay.setAttribute("data-traycer-html-scrollbars", "");
      const shadow = overlay.attachShadow({ mode: "closed" });
      const sheet = document.createElement("style");
      sheet.textContent = `
      :host { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
      button { position: absolute; appearance: none; border: 0; padding: 0; margin: 0; border-radius: 4px; background: var(--color-text-tertiary, GrayText); opacity: 0; transition: opacity 200ms; pointer-events: none; touch-action: none; }
      button[hidden] { display: none; }
      :host([data-active]) button, button:focus-visible { opacity: .5; pointer-events: auto; }
      button:hover, button:active { opacity: .85; }
      .vertical { right: 3px; top: 6px; width: 5px; }
      .horizontal { left: 6px; bottom: 3px; height: 5px; }
      @media (prefers-reduced-motion: reduce) { button { transition: none; } }
    `;
      shadow.appendChild(sheet);
      const makeThumb = (isVertical: boolean): HTMLButtonElement => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = isVertical ? "vertical" : "horizontal";
        button.setAttribute("role", "scrollbar");
        button.setAttribute(
          "aria-label",
          isVertical ? "Scroll page vertically" : "Scroll page horizontally",
        );
        button.setAttribute(
          "aria-orientation",
          isVertical ? "vertical" : "horizontal",
        );
        button.setAttribute("aria-valuemin", "0");
        let start: {
          pointerId: number;
          coordinate: number;
          scroll: number;
        } | null = null;
        button.addEventListener("pointerdown", (event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          dragging = true;
          start = {
            pointerId: event.pointerId,
            coordinate: isVertical ? event.clientY : event.clientX,
            scroll: isVertical ? window.scrollY : window.scrollX,
          };
          button.setPointerCapture(event.pointerId);
          showScrollbars();
        });
        button.addEventListener("pointermove", (event) => {
          const root = document.scrollingElement;
          if (
            start === null ||
            start.pointerId !== event.pointerId ||
            root === null
          )
            return;
          const viewport = isVertical ? window.innerHeight : window.innerWidth;
          const extent = isVertical ? root.scrollHeight : root.scrollWidth;
          const length = isVertical ? button.offsetHeight : button.offsetWidth;
          const delta =
            (isVertical ? event.clientY : event.clientX) - start.coordinate;
          const position =
            start.scroll +
            (delta * (extent - viewport)) / Math.max(1, viewport - 12 - length);
          window.scrollTo(
            isVertical
              ? { top: position, behavior: "instant" }
              : { left: position, behavior: "instant" },
          );
        });
        const finish = (): void => {
          start = null;
          dragging = false;
          showScrollbars();
        };
        button.addEventListener("pointerup", finish);
        button.addEventListener("pointercancel", finish);
        button.addEventListener("lostpointercapture", finish);
        button.addEventListener("pointerenter", () => {
          hovering = true;
          showScrollbars();
        });
        button.addEventListener("pointerleave", () => {
          hovering = false;
          showScrollbars();
        });
        button.addEventListener("keydown", (event) => {
          let amount = 0;
          if (event.key === "PageDown") amount = window.innerHeight;
          else if (event.key === "PageUp") amount = -window.innerHeight;
          else if (event.key === "ArrowDown" || event.key === "ArrowRight")
            amount = 40;
          else if (event.key === "ArrowUp" || event.key === "ArrowLeft")
            amount = -40;
          if (amount === 0) return;
          event.preventDefault();
          window.scrollBy(
            isVertical
              ? { top: amount, behavior: "instant" }
              : { left: amount, behavior: "instant" },
          );
        });
        shadow.appendChild(button);
        return button;
      };
      vertical = makeThumb(true);
      horizontal = makeThumb(false);
      document.documentElement.appendChild(overlay);
      const nestedTimers = new Map<HTMLElement, number>();
      document.addEventListener(
        "scroll",
        (event) => {
          scheduleScrollbars();
          showScrollbars();
          // Only the scroller being used changes colour. Updating a root theme
          // variable on every scroll would restyle a large artifact's whole DOM.
          const target = event.target;
          if (
            target instanceof HTMLElement &&
            target !== document.scrollingElement
          ) {
            const previous = nestedTimers.get(target);
            if (previous !== undefined) window.clearTimeout(previous);
            else
              target.style.setProperty(
                "--traycer-scrollbar-thumb",
                "var(--color-text-tertiary, GrayText)",
              );
            nestedTimers.set(
              target,
              window.setTimeout(() => {
                target.style.removeProperty("--traycer-scrollbar-thumb");
                nestedTimers.delete(target);
              }, 1000),
            );
          }
        },
        { capture: true, passive: true },
      );
      document.addEventListener(
        "pointermove",
        (event) => {
          if (
            event.clientX >= window.innerWidth - 14 ||
            event.clientY >= window.innerHeight - 14
          )
            showScrollbars();
        },
        { passive: true },
      );
      window.addEventListener("resize", scheduleScrollbars, { passive: true });
      const observer = new ResizeObserver(scheduleScrollbars);
      observer.observe(document.documentElement);
      if (body !== null) observer.observe(body);
      scheduleScrollbars();
    },
    { once: true },
  );
}

export function buildHtmlViewerPrelude(): string {
  return `<script>(${htmlViewerBootstrap.toString()})();</script>`;
}
