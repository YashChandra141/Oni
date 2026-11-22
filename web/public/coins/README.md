# Coin icons

Served at `/coins/<name>.svg`, with `/coins/<name>.png` as the second choice. `CoinIcon` falls back to an initial-letter badge when neither file exists, so a missing icon is fine.

Names: btc, eth, sol, bnb, xrp, doge, jup, wif, bonk, pepe.

Run `bun run icons` from the repo root (needs network) to download what is available. For each coin the script tries, in order:

1. The SVG from [spothq/cryptocurrency-icons](https://github.com/spothq/cryptocurrency-icons) (`svg/color/`, CC0).
2. For `jup`, `wif`, and `bonk`, the logo that the Jupiter token API lists for the mint, saved as a PNG.

Coins with no result (for example `pepe`) use the badge fallback, or you can save an icon by hand from the project's official brand assets.
