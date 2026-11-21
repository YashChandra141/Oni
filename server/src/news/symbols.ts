// Symbol matching for news titles and CryptoPanic instrument codes (Req 19, design "News").
// Pure: maps external text to the ten internal symbols. Mint addresses never come from here.

export const NEWS_SYMBOLS = [
  "BTC-USD",
  "ETH-USD",
  "SOL-USD",
  "BNB-USD",
  "XRP-USD",
  "DOGE-USD",
  "JUP-USD",
  "WIF-USD",
  "BONK-USD",
  "PEPE-USD",
] as const;
export type NewsSymbol = (typeof NEWS_SYMBOLS)[number];

/** Case-insensitive, word-boundary aliases per symbol. */
const ALIASES: Readonly<Record<NewsSymbol, readonly string[]>> = {
  "BTC-USD": ["BTC", "Bitcoin"],
  "ETH-USD": ["ETH", "Ethereum", "Ether"],
  "SOL-USD": ["SOL", "Solana"],
  "BNB-USD": ["BNB", "BNB Chain", "Binance Coin"],
  "XRP-USD": ["XRP", "Ripple"],
  "DOGE-USD": ["DOGE", "Dogecoin"],
  "JUP-USD": ["JUP", "Jupiter exchange", "Jupiter aggregator", "Jupiter DEX"],
  "WIF-USD": ["WIF", "dogwifhat"],
  "BONK-USD": ["BONK"],
  "PEPE-USD": ["PEPE"],
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MATCHERS: readonly { readonly symbol: NewsSymbol; readonly re: RegExp }[] = NEWS_SYMBOLS.map((symbol) => ({
  symbol,
  re: new RegExp(`(?<![A-Za-z0-9])(?:${ALIASES[symbol].map(escapeRegex).join("|")})(?![A-Za-z0-9])`, "i"),
}));

/** Internal symbols mentioned in a title, in Instrument_Table order. */
export function matchSymbols(text: string): NewsSymbol[] {
  return MATCHERS.filter((m) => m.re.test(text)).map((m) => m.symbol);
}

/** Maps a CryptoPanic instrument code (`BTC`) to an internal symbol, or null. */
export function symbolFromCode(code: string): NewsSymbol | null {
  const upper = code.trim().toUpperCase();
  return NEWS_SYMBOLS.find((s) => s === `${upper}-USD`) ?? null;
}

/** Union of title matches and instrument codes, deduplicated, in table order. */
export function mergeSymbols(title: string, codes: readonly string[] = []): NewsSymbol[] {
  const found = new Set<NewsSymbol>(matchSymbols(title));
  for (const code of codes) {
    const s = symbolFromCode(code);
    if (s !== null) found.add(s);
  }
  return NEWS_SYMBOLS.filter((s) => found.has(s));
}
