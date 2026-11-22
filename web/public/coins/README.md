# Coin icons

Expected files, served at `/coins/<name>.svg`:

btc.svg eth.svg sol.svg bnb.svg xrp.svg doge.svg jup.svg wif.svg bonk.svg pepe.svg

Sources:

- BTC, ETH, SOL, BNB, XRP, DOGE: [spothq/cryptocurrency-icons](https://github.com/spothq/cryptocurrency-icons) (CC0), `svg/color/`.
- JUP, WIF, BONK, PEPE: each project's official brand assets (save by hand if the script gets a 404).

Run `bun run icons` from the repo root to download what is available.

A missing file is fine: `CoinIcon` falls back to the initial-letter badge.
