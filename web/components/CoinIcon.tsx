"use client";

// Round coin icon from /coins/<short>.svg, then .png, then the initial-letter badge. Plain <img>:
// the site is a static export with no image optimizer. In a static export the image can fail before
// hydration, so onError never fires; the effect checks `complete && naturalWidth === 0` too.

import { useEffect, useRef, useState } from "react";

/** Internal ("BTC-USD") or short ("btc") symbol to the lowercase short name. */
export function coinShort(symbol: string): string {
  return (symbol.split("-")[0] ?? symbol).toLowerCase();
}

const EXTENSIONS = ["svg", "png"] as const;

export function CoinIcon({ symbol, size = 20 }: { readonly symbol: string; readonly size?: number }) {
  const short = coinShort(symbol);
  const [attempt, setAttempt] = useState(0);
  const imgRef = useRef<HTMLImageElement>(null);
  const failed = attempt >= EXTENSIONS.length;
  const box = { width: size, height: size };

  // A new symbol starts again at the first source.
  useEffect(() => {
    setAttempt(0);
  }, [short]);

  // Catch an image that already failed before React attached onError.
  useEffect(() => {
    const img = imgRef.current;
    if (img !== null && img.complete && img.naturalWidth === 0) {
      setAttempt((n) => (n === attempt ? n + 1 : n));
    }
  }, [attempt, short]);

  if (failed) {
    return (
      <span
        aria-label={short.toUpperCase()}
        role="img"
        style={{ ...box, fontSize: Math.max(8, Math.round(size * 0.55)) }}
        className="inline-flex shrink-0 items-center justify-center rounded-full border border-crt-line"
      >
        {short.charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={`${short}.${EXTENSIONS[attempt]}`}
      ref={imgRef}
      src={`/coins/${short}.${EXTENSIONS[attempt]}`}
      width={size}
      height={size}
      alt={short.toUpperCase()}
      loading="lazy"
      style={box}
      className="inline-block shrink-0 rounded-full"
      onError={() => setAttempt((n) => (n === attempt ? n + 1 : n))}
    />
  );
}
