// Navigation items shared by the top nav and the sidebar (Task 14.1, Req 21.1).

export interface NavItem {
  readonly label: string;
  readonly href: string;
  /** File name (without .svg) under /brand/icons. */
  readonly icon: string;
}

export const TOP_NAV: readonly NavItem[] = [
  { label: "Trade", href: "/", icon: "trade" },
  { label: "Markets", href: "/markets", icon: "markets" },
  { label: "AI Copilot", href: "/copilot", icon: "ai-copilot" },
  { label: "Backtest", href: "/backtest", icon: "backtest" },
  { label: "Logs", href: "/logs", icon: "logs" },
];

export const SIDEBAR_NAV: readonly NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: "dashboard" },
  { label: "Trade", href: "/", icon: "trade" },
  { label: "Markets", href: "/markets", icon: "markets" },
  { label: "AI Copilot", href: "/copilot", icon: "ai-copilot" },
  { label: "Backtest", href: "/backtest", icon: "backtest" },
  { label: "Portfolio", href: "/portfolio", icon: "portfolio" },
  { label: "Logs", href: "/logs", icon: "logs" },
  { label: "Settings", href: "/settings", icon: "settings" },
];

export const APP_VERSION = "v2.0.0";

/** True when `pathname` is the page of `href`. `/trade` counts as Trade. Tolerates a trailing slash. */
export function isActive(pathname: string | null, href: string): boolean {
  if (pathname === null) return false;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (href === "/") return path === "/" || path === "/trade";
  return path === href;
}
