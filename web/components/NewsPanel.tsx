"use client";

import { memo, useEffect } from "react";
import { useTerminalStore } from "../lib/store";

type NewsItemShape = ReturnType<typeof useTerminalStore.getState>["news"]["items"][number];

/** "5m ago" style age; never negative. */
export function timeAgo(publishedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - publishedAt) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Only http(s) links are opened; anything else is shown as plain text. */
function safeUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

interface NewsRowProps {
  readonly item: NewsItemShape;
  readonly now: number;
}

const NewsRow = memo(function NewsRow({ item, now }: NewsRowProps) {
  const href = safeUrl(item.url);
  return (
    <li className="px-1">
      {href === null ? (
        <span>{item.title}</span>
      ) : (
        <a href={href} target="_blank" rel="noopener noreferrer" className="hover:underline">
          {item.title}
        </a>
      )}
      <div className="flex flex-wrap items-center gap-1 text-phosphor-dim">
        <span>{item.source}</span>
        <span>·</span>
        <span>{timeAgo(item.published_at, now)}</span>
        {item.symbols.map((symbol) => (
          <span key={symbol} className="rounded border border-crt-line px-1">
            {symbol.split("-")[0]}
          </span>
        ))}
      </div>
    </li>
  );
});

export function NewsPanel() {
  const news = useTerminalStore((state) => state.news);
  const subscribeNews = useTerminalStore((state) => state.subscribeNews);
  const connected = useTerminalStore((state) => state.connection.kind === "connected");

  useEffect(() => {
    if (connected) subscribeNews();
  }, [connected, subscribeNews]);

  if (!news.available || news.items.length === 0) {
    return <p className="px-1 text-xs text-phosphor-dim">News unavailable</p>;
  }
  const now = Date.now();

  return (
    <ul aria-label="News" className="space-y-2 text-xs">
      {news.items.map((item) => (
        <NewsRow key={item.id} item={item} now={now} />
      ))}
    </ul>
  );
}

export default NewsPanel;
