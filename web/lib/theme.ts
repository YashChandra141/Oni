/**
 * Oni design tokens (asset pack). Applied through app/globals.css and styles/oni-theme.css.
 * Mirrors web/styles/oni-theme.css.
 */

export const colors = {
  bg: "#0b0b0d",
  panel: "#111114",
  panelRaised: "#17171b",
  border: "#8b0000",
  borderGlow: "#c1121f",
  accent: "#c1121f",
  accentBright: "#ff2a2a",
  text: "#e5e5e5",
  textMuted: "#8a8a8f",
  buy: "#22c55e",
  sell: "#ef4444",
  live: "#22c55e",
  warn: "#f59e0b",
} as const;

export const radii = {
  sm: "4px",
  md: "8px",
  lg: "12px",
  pill: "9999px",
} as const;

export const glows = {
  soft: "0 0 12px rgba(193, 18, 31, 0.35)",
  strong: "0 0 18px rgba(255, 42, 42, 0.55)",
  inset: "inset 0 0 12px rgba(139, 0, 0, 0.35)",
} as const;

export const fonts = {
  sans: "Inter, 'Segoe UI', system-ui, -apple-system, Arial, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  kanji: "'Noto Sans JP', 'Yu Gothic', 'Hiragino Sans', Meiryo, 'MS Gothic', sans-serif",
} as const;

export const theme = { colors, radii, glows, fonts } as const;

export type OniTheme = typeof theme;
