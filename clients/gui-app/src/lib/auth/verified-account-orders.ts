import { create } from "zustand";

let requestOrder = 0;

export function currentAccountRequestOrder(): number {
  return requestOrder;
}

export function nextAccountRequestOrder(): number {
  return ++requestOrder;
}

export interface VerifiedAccountOrder {
  readonly userId: string;
  readonly dispatched: number;
  readonly verified: number;
  readonly teamIds: readonly string[];
}

export interface AccountOrders {
  readonly pending: readonly number[];
  readonly verdict: VerifiedAccountOrder | null;
}

const EMPTY_ACCOUNT_ORDERS: AccountOrders = { pending: [], verdict: null };

const useAccountOrders = create(() => new Map<object, AccountOrders>());

function updateOrders(
  auth: object,
  update: (current: AccountOrders) => AccountOrders,
): void {
  useAccountOrders.setState((accounts) => {
    const current = accounts.get(auth) ?? EMPTY_ACCOUNT_ORDERS;
    const updated = update(current);
    if (updated === current) return accounts;
    const next = new Map(accounts);
    next.set(auth, updated);
    return next;
  }, true);
}

export function beginAccountVerification(auth: object): number {
  const order = nextAccountRequestOrder();
  updateOrders(auth, (current) => ({
    ...current,
    pending: [...current.pending, order],
  }));
  return order;
}

export function finishAccountVerification(
  auth: object,
  dispatched: number,
  verified: Omit<VerifiedAccountOrder, "dispatched" | "verified"> | null,
): void {
  updateOrders(auth, (current) => {
    if (!current.pending.includes(dispatched)) return current;
    const verifiedOrder = verified === null ? 0 : nextAccountRequestOrder();
    return {
      pending: current.pending.filter((order) => order !== dispatched),
      verdict:
        verified !== null && dispatched > (current.verdict?.dispatched ?? 0)
          ? { ...verified, dispatched, verified: verifiedOrder }
          : current.verdict,
    };
  });
}

export function clearAccountVerifications(auth: object): void {
  useAccountOrders.setState((accounts) => {
    if (!accounts.has(auth)) return accounts;
    const next = new Map(accounts);
    next.delete(auth);
    return next;
  }, true);
}

export function readAccountOrders(auth: object | null): AccountOrders {
  return (
    (auth === null ? undefined : useAccountOrders.getState().get(auth)) ??
    EMPTY_ACCOUNT_ORDERS
  );
}

export function subscribeAccountOrders(
  auth: object,
  listener: (account: AccountOrders) => void,
): () => void {
  listener(readAccountOrders(auth));
  return useAccountOrders.subscribe((next, previous) => {
    if (next.get(auth) !== previous.get(auth))
      listener(readAccountOrders(auth));
  });
}
