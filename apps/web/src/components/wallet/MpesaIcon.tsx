/** Shared M-Pesa glyph used by the wallet Deposit/Withdraw destination cards and phone inputs. */
export function MpesaIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <rect x="4" y="3" width="16" height="18" rx="3" />
      <path d="M9 3v18" strokeOpacity="0" />
      <path d="M12 7v6M9.5 9h4a1.5 1.5 0 010 3h-2.5a1.5 1.5 0 000 3H14" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
