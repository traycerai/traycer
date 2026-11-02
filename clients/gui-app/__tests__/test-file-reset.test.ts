import { afterEach, describe, expect, it, vi } from "vitest";
import { resetTestFileState } from "./test-file-reset";

const KEY = "__testFileResetProbe";

afterEach(() => {
  resetTestFileState();
});

describe("what one test file leaves for the next", () => {
  it("removes a global the file added and restores one it replaced", () => {
    const realFetch = globalThis.fetch;
    Reflect.set(globalThis, KEY, 1);
    globalThis.fetch = () => Promise.reject(new Error("replaced"));

    resetTestFileState();

    expect(Reflect.has(globalThis, KEY)).toBe(false);
    expect(globalThis.fetch).toBe(realFetch);
  });

  it("restores a global Vitest keeps behind an accessor", () => {
    const width = window.innerWidth;
    window.innerWidth = width + 123;

    resetTestFileState();

    expect(window.innerWidth).toBe(width);
  });

  it("restores a DOM prototype, whether patched or spied over a fake timer", () => {
    const realFocus: unknown = Reflect.get(HTMLElement.prototype, "focus");
    HTMLElement.prototype.focus = () => undefined;
    const realClearTimeout: unknown = Reflect.get(globalThis, "clearTimeout");
    vi.useFakeTimers();
    vi.spyOn(window, "clearTimeout");

    resetTestFileState();

    expect(Reflect.get(HTMLElement.prototype, "focus")).toBe(realFocus);
    expect(Reflect.get(globalThis, "clearTimeout")).toBe(realClearTimeout);
  });

  it("cancels a timer the file left running", async () => {
    const fired = vi.fn<() => void>();
    setTimeout(fired, 0);
    setInterval(fired, 0);

    resetTestFileState();
    // Real on purpose: a real timer left running is the thing under test.
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(fired).not.toHaveBeenCalled();
  });

  it("removes a listener on the window and the document", () => {
    const heard = vi.fn<() => void>();
    window.addEventListener("resize", heard);
    document.addEventListener("keydown", heard);

    resetTestFileState();
    window.dispatchEvent(new Event("resize"));
    document.dispatchEvent(new Event("keydown"));

    expect(heard).not.toHaveBeenCalled();
  });

  it("clears an expando on a long-lived node, so React listens again", () => {
    Reflect.set(document.body, KEY, true);

    resetTestFileState();

    expect(Reflect.has(document.body, KEY)).toBe(false);
  });

  it("clears the DOM, storage, cookies and URL", () => {
    document.body.appendChild(document.createElement("div"));
    document.head.appendChild(document.createElement("style"));
    document.documentElement.setAttribute("data-theme", "dark");
    window.localStorage.setItem(KEY, "1");
    window.sessionStorage.setItem(KEY, "1");
    document.cookie = `${KEY}=1`;
    window.history.replaceState(null, "", "/elsewhere?q=1");

    resetTestFileState();

    expect(document.body.childElementCount).toBe(0);
    expect(document.head.childElementCount).toBe(0);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    expect(document.cookie).toBe("");
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("");
  });

  it("answers hasFocus() false again after the file focused something", () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    expect(document.hasFocus()).toBe(true);

    resetTestFileState();

    expect(document.hasFocus()).toBe(false);
  });

  it("does not count a synthetic focus event as the window taking focus", () => {
    const button = document.createElement("button");
    document.body.appendChild(button);

    button.dispatchEvent(new FocusEvent("focus"));

    expect(document.hasFocus()).toBe(false);
  });
});
