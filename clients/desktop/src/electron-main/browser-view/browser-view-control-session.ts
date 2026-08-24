import { randomUUID } from "node:crypto";
import type {
  BrowserViewControlAction,
  BrowserViewControlActionResult,
} from "../../ipc-contracts/browser-view-types";
import type { BrowserViewDebugger } from "./browser-view-port";

interface SensitiveApproval {
  readonly actionId: string;
  readonly action: BrowserViewControlAction["action"];
}

/** Serializes one agent's temporary control lease over a browser guest. */
export class BrowserViewControlSession {
  readonly controlId: string;
  private readonly expiresAt: number;
  private readonly browserDebugger: BrowserViewDebugger;
  private readonly pendingSensitiveApprovals = new Map<
    string,
    SensitiveApproval
  >();
  private queue: Promise<unknown> = Promise.resolve(null);
  private active = true;

  constructor(
    controlId: string,
    expiresAt: number,
    browserDebugger: BrowserViewDebugger,
  ) {
    this.controlId = controlId;
    this.expiresAt = expiresAt;
    this.browserDebugger = browserDebugger;
  }

  matches(controlId: string): boolean {
    return this.active && this.controlId === controlId;
  }

  isExpired(now: number): boolean {
    return this.expiresAt <= now;
  }

  cancel(): void {
    this.active = false;
    this.pendingSensitiveApprovals.clear();
  }

  execute(
    input: BrowserViewControlAction,
  ): Promise<BrowserViewControlActionResult> {
    if (!this.matches(input.controlId)) {
      return Promise.resolve({
        status: "cancelled",
        reason: "Browser control lock is not active.",
      });
    }
    const run = this.queue.then(async () => {
      if (!this.active) return controlCancelled();
      const result = await this.sendCommand(input);
      return this.active ? result : controlCancelled();
    });
    this.queue = run.catch(() => null);
    return run.catch((error: unknown) => ({
      status: "denied",
      reason: error instanceof Error ? error.message : String(error),
    }));
  }

  private sendCommand(
    input: BrowserViewControlAction,
  ): Promise<BrowserViewControlActionResult> {
    if (!this.browserDebugger.isAttached()) {
      this.browserDebugger.attach("1.3");
    }
    if (input.action.kind === "navigate") {
      return this.browserDebugger
        .sendCommand("Page.navigate", { url: input.action.url }, undefined)
        .then((value) => ({ status: "completed" as const, value }));
    }
    if (input.action.kind === "scroll") {
      return this.browserDebugger
        .sendCommand(
          "Input.dispatchMouseEvent",
          {
            type: "mouseWheel",
            x: 1,
            y: 1,
            deltaX: input.action.deltaX,
            deltaY: input.action.deltaY,
          },
          undefined,
        )
        .then((value) => ({ status: "completed" as const, value }));
    }
    if (input.action.kind === "click") {
      return this.clickSelector(input.action.selector).then((value) => ({
        status: "completed" as const,
        value,
      }));
    }
    return this.typeIntoSelector(input);
  }

  private async clickSelector(selector: string): Promise<unknown> {
    const point = await this.resolveSelectorCenter(selector);
    await this.browserDebugger.sendCommand(
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", x: point.x, y: point.y },
      undefined,
    );
    await this.browserDebugger.sendCommand(
      "Input.dispatchMouseEvent",
      {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
      },
      undefined,
    );
    return this.browserDebugger.sendCommand(
      "Input.dispatchMouseEvent",
      {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
      },
      undefined,
    );
  }

  private async typeIntoSelector(
    input: BrowserViewControlAction,
  ): Promise<BrowserViewControlActionResult> {
    if (input.action.kind !== "type") return controlCancelled();
    const target = await this.focusSelectorForTyping(input.action.selector);
    if (target.sensitive && !this.consumeSensitiveApproval(input)) {
      const approvalId = randomUUID();
      this.pendingSensitiveApprovals.set(approvalId, {
        actionId: input.actionId,
        action: input.action,
      });
      return {
        status: "needs-approval",
        approvalId,
        reason: "Typing into a password field requires explicit approval.",
      };
    }
    const value = await this.browserDebugger.sendCommand(
      "Input.insertText",
      { text: input.action.text },
      undefined,
    );
    return { status: "completed", value };
  }

  private consumeSensitiveApproval(input: BrowserViewControlAction): boolean {
    if (input.sensitiveApprovalId === null || input.action.kind !== "type") {
      return false;
    }
    const approval = this.pendingSensitiveApprovals.get(
      input.sensitiveApprovalId,
    );
    if (
      approval === undefined ||
      approval.actionId !== input.actionId ||
      !controlActionsEqual(approval.action, input.action)
    ) {
      return false;
    }
    this.pendingSensitiveApprovals.delete(input.sensitiveApprovalId);
    return true;
  }

  private async resolveSelectorCenter(
    selector: string,
  ): Promise<{ readonly x: number; readonly y: number }> {
    const result = await this.browserDebugger.sendCommand(
      "Runtime.evaluate",
      {
        expression: selectorCenterExpression(selector),
        returnByValue: true,
      },
      undefined,
    );
    const value = readEvaluationValue(result);
    if (typeof value.x !== "number" || typeof value.y !== "number") {
      throw new Error("Could not resolve selector center.");
    }
    return { x: value.x, y: value.y };
  }

  private async focusSelectorForTyping(
    selector: string,
  ): Promise<{ readonly sensitive: boolean }> {
    const result = await this.browserDebugger.sendCommand(
      "Runtime.evaluate",
      {
        expression: focusSelectorForTypingExpression(selector),
        returnByValue: true,
      },
      undefined,
    );
    const value = readEvaluationValue(result);
    if (value.focused !== true || typeof value.sensitive !== "boolean") {
      throw new Error("Could not focus selector.");
    }
    return { sensitive: value.sensitive };
  }
}

function controlCancelled(): BrowserViewControlActionResult {
  return { status: "cancelled", reason: "user took over" };
}

function readEvaluationValue(value: unknown): Record<string, unknown> {
  if (
    !isRecord(value) ||
    !isRecord(value.result) ||
    !isRecord(value.result.value)
  ) {
    throw new Error("Browser control evaluation returned no value.");
  }
  return value.result.value;
}

function selectorCenterExpression(selector: string): string {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof Element)) return null;
    const rect = element.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  })()`;
}

function focusSelectorForTypingExpression(selector: string): string {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return { focused: false, sensitive: false };
    element.focus();
    const sensitiveAutocomplete = new Set([
      "current-password",
      "new-password",
      "one-time-code",
    ]);
    const autocompleteTokens = element
      .autocomplete
      .toLowerCase()
      .split(/\\s+/u)
      .filter((token) => token.length > 0);
    const isInput = element instanceof HTMLInputElement;
    const sensitive =
      isInput &&
      (element.type.toLowerCase() === "password" ||
        autocompleteTokens.some(
          (token) =>
            sensitiveAutocomplete.has(token) || token.startsWith("cc-"),
        ));
    return { focused: document.activeElement === element, sensitive };
  })()`;
}

function controlActionsEqual(
  left: BrowserViewControlAction["action"],
  right: BrowserViewControlAction["action"],
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "click") {
    return right.kind === "click" && left.selector === right.selector;
  }
  if (left.kind === "type") {
    return (
      right.kind === "type" &&
      left.selector === right.selector &&
      left.text === right.text
    );
  }
  if (left.kind === "scroll") {
    return (
      right.kind === "scroll" &&
      left.deltaX === right.deltaX &&
      left.deltaY === right.deltaY
    );
  }
  return right.kind === "navigate" && left.url === right.url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
