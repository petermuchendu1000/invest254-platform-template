/**
 * docs/42 UI-4 — "links never act" (RFC 9110 §9.2.1 safe methods). A withdrawal alert's Approve/Reject
 * buttons open `/admin/withdrawals?highlight=<txId>&do=<approve|reject>`. That URL may only SELECT the
 * row and PRE-OPEN a confirmation; the state change happens on an explicit click. (Before: `do=reject`
 * executed the rejection on page load, so any link — or a prefetch — could reject a withdrawal.)
 * Pure and dependency-free so the root test runner can unit-test it.
 */
export interface WithdrawalDeepLink {
  highlight: string | null;
  intent: 'approve' | 'reject' | null;
  /** The query string to put back in the address bar: `do` removed, `highlight` kept. */
  cleanedSearch: string;
}

const TX_RE = /^[A-Za-z0-9-]{1,64}$/;

export function parseWithdrawalDeepLink(search: string): WithdrawalDeepLink {
  const params = new URLSearchParams(search);
  const rawTx = params.get('highlight');
  const highlight = rawTx && TX_RE.test(rawTx) ? rawTx : null;
  const act = params.get('do');
  const intent = highlight && (act === 'approve' || act === 'reject') ? act : null;
  params.delete('do');
  const qs = params.toString();
  return { highlight, intent, cleanedSearch: qs ? `?${qs}` : '' };
}
