// Dev-only: downloads coin icons into web/public/coins/. Never run by the server.
// Sources, in order: GitHub cryptocurrency-icons SVG; for the Solana tokens, the logo that the
// Jupiter token API lists for the mint (saved as PNG).
// Usage: bun run icons
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = "https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/svg/color";
const JUP_SEARCH = "https://lite-api.jup.ag/tokens/v2/search";
const COINS = ["btc", "eth", "sol", "bnb", "xrp", "doge", "jup", "wif", "bonk", "pepe"] as const;
/** Mints from the Venue_Symbol_Map (rust/crates/engine/src/feed/venue.rs). */
const MINTS: Readonly<Record<string, string>> = {
  jup: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  wif: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  bonk: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
};
const MAX_BYTES = 200 * 1024;
const MAX_PNG_BYTES = 300 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const OUT = join(import.meta.dir, "..", "web", "public", "coins");

mkdirSync(OUT, { recursive: true });

async function fetchSvg(coin: string): Promise<string | null> {
  const res = await fetch(`${BASE}/${coin}.svg`);
  if (!res.ok) return null;
  const body = await res.text();
  if (body.length > MAX_BYTES) return null;
  const head = body.trimStart().slice(0, 5).toLowerCase();
  if (!head.startsWith("<svg") && !head.startsWith("<?xml")) return null;
  if (/<script/i.test(body)) return null;
  return body;
}

/** The logo URL for a mint from the Jupiter token API, https only. */
async function jupiterLogoUrl(mint: string): Promise<string | null> {
  const res = await fetch(`${JUP_SEARCH}?query=${encodeURIComponent(mint)}`);
  if (!res.ok) return null;
  const data: unknown = await res.json();
  if (!Array.isArray(data)) return null;
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const t = item as Record<string, unknown>;
    if (t.id !== mint && t.address !== mint) continue;
    const url = typeof t.icon === "string" ? t.icon : typeof t.logoURI === "string" ? t.logoURI : null;
    if (url !== null && URL.canParse(url) && new URL(url).protocol === "https:") return url;
  }
  return null;
}

async function fetchPng(url: string): Promise<Uint8Array | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0 || bytes.length >= MAX_PNG_BYTES) return null;
  if (!PNG_MAGIC.every((b, i) => bytes[i] === b)) return null;
  return bytes;
}

const ok: string[] = [];
const fallback: string[] = [];
for (const coin of COINS) {
  try {
    const svg = await fetchSvg(coin).catch(() => null);
    if (svg !== null) {
      await Bun.write(join(OUT, `${coin}.svg`), svg);
      ok.push(`${coin}.svg`);
      continue;
    }
    const mint = MINTS[coin];
    if (mint !== undefined) {
      const url = await jupiterLogoUrl(mint);
      const png = url === null ? null : await fetchPng(url);
      if (png !== null) {
        await Bun.write(join(OUT, `${coin}.png`), png);
        ok.push(`${coin}.png`);
        continue;
      }
    }
    fallback.push(coin);
  } catch {
    fallback.push(coin);
  }
}
console.log(`downloaded: ${ok.join(", ") || "none"}`);
console.log(`will fall back to initials: ${fallback.join(", ") || "none"}`);
