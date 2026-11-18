export class MruTracker {
  private readonly ids: string[] = [];

  touch(windowId: string): void {
    const next = this.ids.filter((id) => id !== windowId);
    next.unshift(windowId);
    this.ids.length = 0;
    this.ids.push(...next);
  }

  remove(windowId: string): void {
    const next = this.ids.filter((id) => id !== windowId);
    this.ids.length = 0;
    this.ids.push(...next);
  }

  mostRecent(): string | null {
    return this.ids[0] ?? null;
  }

  list(): readonly string[] {
    return [...this.ids];
  }
}
