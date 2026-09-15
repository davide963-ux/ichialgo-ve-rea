/** Pip size: 0.01 for JPY-quoted pairs, 0.0001 for everything else. */
export function pipSize(symbol: string): number {
  return symbol.toUpperCase().endsWith('/JPY') ? 0.01 : 0.0001;
}

export function toPips(symbol: string, priceDistance: number): number {
  return priceDistance / pipSize(symbol);
}
