/**
 * The gateway codes players are allowed to see. Paynicorn is a confidential supplier: everything a
 * player's browser receives (the deposit-methods list, the deposit route, transaction history) names it
 * `payx`, so neither the network tab nor the shipped web bundle reveals who processes the payment.
 * Operator-only surfaces (/platform, /admin) keep the real code. docs/53.
 */
const TO_PUBLIC: Readonly<Record<string, string>> = { paynicorn: "payx" };

export function publicProviderCode(code: string): string {
  return TO_PUBLIC[code] ?? code;
}

/**
 * Rewrites `provider` (and an id prefixed with it, e.g. `paynicorn-mpesa`) to the public code, and drops
 * anything that would name the supplier by another route.
 *
 * `iconUrl` is the one that bites: the gateway publishes its method logos on its OWN cdn, so passing it
 * through would put the supplier's hostname straight in the player's browser — the exact leak the public
 * code exists to prevent. The method's own name ("M-Pesa", "Card") carries no such hint and stays.
 */
export function publicProvider<T extends { provider: string; id?: string; iconUrl?: string }>(row: T): T {
  const pub = publicProviderCode(row.provider);
  if (pub === row.provider) return row;
  const { iconUrl: _dropped, ...rest } = row;
  const out = { ...rest, provider: pub } as T;
  if (typeof row.id === "string" && row.id.startsWith(`${row.provider}-`)) out.id = `${pub}${row.id.slice(row.provider.length)}`;
  return out;
}
