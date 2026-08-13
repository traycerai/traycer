export type ThanosIdentity = {
  readonly userId: "thanos-local";
  readonly token: string;
};

export function acceptBearer(token: string): ThanosIdentity | null {
  if (token.trim().length === 0) {
    return null;
  }
  return { userId: "thanos-local", token };
}
