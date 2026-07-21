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

export function setTabSplitCompatibility(supported: boolean): void {
  compatibility = supported ? SUPPORTED : UNSUPPORTED;
}

export function getTabSplitCompatibility(): TabSplitCompatibility {
  return compatibility;
}

export function canMutateTabSplits(): boolean {
  return compatibility.supported;
}
