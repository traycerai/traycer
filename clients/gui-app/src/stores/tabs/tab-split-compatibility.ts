export interface TabSplitCompatibility {
  readonly supported: boolean;
  readonly reason: string | null;
}

const SUPPORTED: TabSplitCompatibility = { supported: true, reason: null };
const UNSUPPORTED: TabSplitCompatibility = {
  supported: false,
  reason: "Split tabs need a desktop restart to finish updating.",
};

let compatibility = SUPPORTED;
const listeners = new Set<() => void>();

export function setTabSplitCompatibility(supported: boolean): void {
  compatibility = supported ? SUPPORTED : UNSUPPORTED;
  listeners.forEach((listener) => listener());
}

export function getTabSplitCompatibility(): TabSplitCompatibility {
  return compatibility;
}

export function canMutateTabSplits(): boolean {
  return compatibility.supported;
}

export function subscribeTabSplitCompatibility(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
