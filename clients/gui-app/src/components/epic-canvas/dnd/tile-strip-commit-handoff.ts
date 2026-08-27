import { animate, type MotionValue, type Transition } from "motion/react";

interface Entry {
  readonly value: MotionValue<number>;
  node: HTMLElement | null;
  targetX: number;
  transition: Transition;
  lastBaselineLeft: number | null;
}

const entries = new Map<MotionValue<number>, Entry>();
const armedGroupIds = new Set<string>();

export function registerTileStripItem(value: MotionValue<number>): () => void {
  entries.set(value, {
    value,
    node: null,
    targetX: value.get(),
    transition: { duration: 0 },
    lastBaselineLeft: null,
  });
  return () => entries.delete(value);
}

export function syncTileStripItem(input: {
  readonly value: MotionValue<number>;
  readonly node: HTMLElement | null;
  readonly targetX: number;
  readonly transition: Transition;
}): void {
  const entry = entries.get(input.value);
  if (entry === undefined) return;
  entry.node = input.node;
  entry.targetX = input.targetX;
  entry.transition = input.transition;
}

export function armTileStripCommitHandoff(groupId: string): void {
  armedGroupIds.add(groupId);
}

export function disarmTileStripCommitHandoff(): void {
  armedGroupIds.clear();
}

export function runTileStripCommitHandoff(groupId: string): void {
  const armed = armedGroupIds.has(groupId);
  for (const entry of entries.values()) {
    const node = entry.node;
    if (
      node === null ||
      node.closest("[data-group-id]")?.getAttribute("data-group-id") !== groupId
    ) {
      continue;
    }
    const previous = entry.lastBaselineLeft;
    const next = node.offsetLeft;
    entry.lastBaselineLeft = next;
    if (!armed || previous === null || previous === next) continue;
    entry.value.jump(previous + entry.value.get() - next);
    animate(entry.value, entry.targetX, entry.transition);
  }
  if (armed) armedGroupIds.delete(groupId);
}
