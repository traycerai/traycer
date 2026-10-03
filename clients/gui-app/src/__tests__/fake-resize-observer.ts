/**
 * A `ResizeObserver` the test drives by hand: nothing fires until `emit` is
 * called, and the entry carries only the sizes the hooks under test read
 * (`borderBoxSize`). Installed over the setup file's inert mock and put back
 * by `restore`.
 */
export class FakeResizeObserver implements ResizeObserver {
  static instances: Array<FakeResizeObserver> = [];

  target: Element | null = null;
  disconnected = false;

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.target = target;
  }

  unobserve(): void {}

  disconnect(): void {
    this.disconnected = true;
  }

  emit(size: { readonly inline: number; readonly block: number }): void {
    this.callback([this.entry(size)], this);
  }

  /**
   * What an engine without `borderBoxSize` delivers (Safari before 15.4, and
   * other test stubs): only `contentRect` carries the size.
   */
  emitWithoutBorderBox(size: {
    readonly inline: number;
    readonly block: number;
  }): void {
    const entry = this.entry(size);
    Reflect.deleteProperty(entry, "borderBoxSize");
    this.callback([entry], this);
  }

  private entry(size: {
    readonly inline: number;
    readonly block: number;
  }): ResizeObserverEntry {
    const target = this.target;
    if (target === null) throw new Error("observer has no target");
    const box = { inlineSize: size.inline, blockSize: size.block };
    const entry: ResizeObserverEntry = {
      target,
      borderBoxSize: [box],
      contentBoxSize: [box],
      devicePixelContentBoxSize: [box],
      contentRect: {
        x: 0,
        y: 0,
        width: size.inline,
        height: size.block,
        top: 0,
        left: 0,
        right: size.inline,
        bottom: size.block,
        toJSON: () => ({}),
      },
    };
    return entry;
  }
}

export function installFakeResizeObserver(): {
  readonly live: () => Array<FakeResizeObserver>;
  readonly restore: () => void;
} {
  const previous = Object.getOwnPropertyDescriptor(
    globalThis,
    "ResizeObserver",
  );
  FakeResizeObserver.instances = [];
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: FakeResizeObserver,
  });
  return {
    live: () =>
      FakeResizeObserver.instances.filter((observer) => !observer.disconnected),
    restore: () => {
      if (previous !== undefined) {
        Object.defineProperty(globalThis, "ResizeObserver", previous);
      }
      FakeResizeObserver.instances = [];
    },
  };
}
