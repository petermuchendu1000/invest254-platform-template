/** Same rule as the engine's mpesaAccountRef (Daraja allows 12 characters): TRIO-2026-00012 -> TRIO2600012. */
export function mpesaRefFor(invoiceNumber: string): string {
  const [prefix = 'INV', year = '', seq = ''] = invoiceNumber.split('-');
  const tail = `${year.slice(-2)}${seq}`;
  return `${prefix.slice(0, Math.max(1, 12 - tail.length))}${tail}`.slice(0, 12);
}
