export interface AnnotationTargetOption {
  readonly chatId: string;
  readonly label: string;
}

export interface AnnotationTargetPicker {
  readonly root: HTMLElement;
  readonly trigger: HTMLButtonElement;
  readonly close: (restoreFocus: boolean) => void;
  readonly dispose: () => void;
  readonly getDefaultChatId: () => string | null;
  readonly isOpen: () => boolean;
  readonly setDisabled: (disabled: boolean) => void;
  readonly setTargets: (
    targets: readonly AnnotationTargetOption[],
    defaultChatId: string | null,
  ) => void;
}

export const ANNOTATION_TARGET_PICKER_CSS = [
  ".target-picker{position:relative;min-width:0;width:fit-content;max-width:100%;justify-self:end;}",
  ".target-trigger{display:grid;grid-template-columns:minmax(0,1fr) auto;min-height:32px;max-width:100%;align-items:center;gap:8px;background:var(--annotation-primary);color:var(--annotation-primary-foreground);border:0;border-radius:var(--annotation-radius);padding:7px 10px;font-size:13px;font-weight:600;line-height:1.25;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.16);}",
  ".target-trigger::after{content:'';width:7px;height:7px;flex:none;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:translateY(-2px) rotate(45deg);}",
  ".target-trigger[aria-expanded='true']{background:color-mix(in srgb,var(--annotation-primary) 88%,var(--annotation-background));}",
  ".target-trigger:focus-visible,.target-option:focus-visible{outline:2px solid var(--annotation-ring);outline-offset:2px;}",
  ".target-trigger:disabled{opacity:.45;cursor:default;}",
  ".target-menu{position:fixed;inset:auto;z-index:2147483647;width:max-content;min-width:min(20ch,calc(100vw - 24px));max-width:min(40ch,calc(100vw - 24px));max-height:min(40vh,240px);overflow:auto;margin:0;padding:4px;border:1px solid var(--annotation-border);border-radius:calc(var(--annotation-radius) + 3px);background:var(--annotation-popover);color:var(--annotation-popover-foreground);box-shadow:0 10px 28px rgba(0,0,0,.24);}",
  ".target-menu::backdrop{background:transparent;}",
  ".target-option{display:block;width:100%;min-height:28px;overflow:hidden;text-overflow:ellipsis;border:0;border-radius:var(--annotation-radius);background:transparent;color:inherit;padding:5px 8px;font:inherit;font-size:13px;font-weight:500;line-height:1.35;text-align:start;white-space:nowrap;cursor:pointer;}",
  ".target-option:focus-visible{background:var(--annotation-accent);color:var(--annotation-accent-foreground);}",
  "@media (hover:hover){.target-trigger:hover{background:color-mix(in srgb,var(--annotation-primary) 88%,var(--annotation-background));}.target-option:hover{background:var(--annotation-accent);color:var(--annotation-accent-foreground);}}",
].join("");

export function createAnnotationTargetPicker(input: {
  readonly document: Document;
  readonly onSelect: (chatId: string) => void;
}): AnnotationTargetPicker {
  const D = input.document;
  const W = D.defaultView;
  const listeners = new AbortController();
  const root = D.createElement("div");
  root.className = "target-picker";
  const trigger = D.createElement("button");
  trigger.type = "button";
  trigger.className = "target-trigger";
  trigger.textContent = "Send to chat";
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  const menu = D.createElement("div");
  menu.className = "target-menu";
  menu.id = "traycer-annotation-target-menu";
  menu.popover = "auto";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Annotation destination");
  trigger.popoverTargetElement = menu;
  trigger.popoverTargetAction = "toggle";
  trigger.setAttribute("aria-controls", menu.id);
  root.append(trigger, menu);

  let targets: readonly AnnotationTargetOption[] = [];
  let defaultChatId: string | null = null;

  function isOpen(): boolean {
    try {
      return menu.matches(":popover-open");
    } catch {
      return false;
    }
  }

  function close(restoreFocus: boolean): void {
    if (isOpen() && typeof menu.hidePopover === "function") {
      menu.hidePopover();
    }
    if (restoreFocus) trigger.focus();
  }

  function preferredOption(): HTMLButtonElement | null {
    const selector = '[data-chat-id="' + CSS.escape(defaultChatId ?? "") + '"]';
    return (
      menu.querySelector<HTMLButtonElement>(selector) ??
      menu.querySelector<HTMLButtonElement>("button")
    );
  }

  function openAndFocus(): void {
    if (targets.length === 0) return;
    if (!isOpen() && typeof menu.showPopover === "function") {
      menu.showPopover();
    }
    preferredOption()?.focus();
  }

  function placeMenu(): void {
    if (W === null) return;
    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const left = Math.min(
      Math.max(8, triggerRect.right - menuRect.width),
      Math.max(8, W.innerWidth - menuRect.width - 8),
    );
    menu.style.left = String(left) + "px";
    menu.style.top =
      String(Math.max(8, triggerRect.top - menuRect.height - 6)) + "px";
  }

  function setTargets(
    nextTargets: readonly AnnotationTargetOption[],
    nextDefaultChatId: string | null,
  ): void {
    targets = nextTargets.filter((target) => target.chatId.length > 0);
    defaultChatId = targets.some(
      (target) => target.chatId === nextDefaultChatId,
    )
      ? nextDefaultChatId
      : (targets[0]?.chatId ?? null);
    menu.replaceChildren();
    for (const target of targets) {
      const option = D.createElement("button");
      option.type = "button";
      option.className = "target-option";
      option.setAttribute("role", "menuitem");
      option.setAttribute("data-chat-id", target.chatId);
      option.textContent = target.label || "Untitled chat";
      option.title = option.textContent;
      menu.appendChild(option);
    }
    trigger.disabled = targets.length === 0;
    close(false);
  }

  menu.addEventListener(
    "toggle",
    () => {
      const open = isOpen();
      trigger.setAttribute("aria-expanded", String(open));
      if (open) placeMenu();
    },
    { signal: listeners.signal },
  );
  menu.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const option = target.closest<HTMLElement>("[data-chat-id]");
      const chatId = option?.getAttribute("data-chat-id") ?? null;
      if (chatId === null) return;
      event.preventDefault();
      event.stopPropagation();
      close(false);
      input.onSelect(chatId);
    },
    { signal: listeners.signal },
  );
  root.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Tab") {
        close(false);
        return;
      }
      if (!isOpen() && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        event.stopPropagation();
        openAndFocus();
        return;
      }
      if (!isOpen()) return;
      const options = Array.from(
        menu.querySelectorAll<HTMLButtonElement>("button"),
      );
      const current = options.indexOf(D.activeElement as HTMLButtonElement);
      let next = current;
      if (event.key === "ArrowDown") next = (current + 1) % options.length;
      else if (event.key === "ArrowUp") {
        next = (current - 1 + options.length) % options.length;
      } else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = options.length - 1;
      else return;
      event.preventDefault();
      event.stopPropagation();
      options[next]?.focus();
    },
    { signal: listeners.signal },
  );

  return {
    root,
    trigger,
    close,
    dispose: () => listeners.abort(),
    getDefaultChatId: () => defaultChatId,
    isOpen,
    setDisabled: (disabled) => {
      trigger.disabled = disabled || targets.length === 0;
    },
    setTargets,
  };
}
