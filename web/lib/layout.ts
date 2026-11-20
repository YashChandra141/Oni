// Fixed-height named-area grid for the web page (chart-and-tape-fix, Req 2.9, 3.13).
// Pure data: only the CSSProperties type is imported from React.
import type { CSSProperties } from "react";

/** Column tracks: watchlist, chart, side column. */
export const GRID_COLUMNS = "12rem minmax(0,1fr) 16rem";

/** Row tracks. Only the status-bar and command-bar rows are `auto`. */
export const GRID_ROWS = "auto minmax(0,1fr) 12rem auto";

/** Grid area rows, one string per row. */
export const GRID_AREA_ROWS = [
  "status status status",
  "watch chart side",
  "tape account account",
  "command command command",
] as const;

/** `grid-template-areas` value. */
export const GRID_AREAS = GRID_AREA_ROWS.map((row) => `"${row}"`).join(" ");

export type PanelId =
  | "status"
  | "watch"
  | "chart"
  | "side"
  | "tape"
  | "account"
  | "command";

/** Each panel sits in exactly one named area. */
export const PANEL_AREA: Readonly<Record<PanelId, string>> = {
  status: "status",
  watch: "watch",
  chart: "chart",
  side: "side",
  tape: "tape",
  account: "account",
  command: "command",
};

/** Ready-to-use style for the page's grid container. */
export const GRID_STYLE: CSSProperties = {
  gridTemplateColumns: GRID_COLUMNS,
  gridTemplateRows: GRID_ROWS,
  gridTemplateAreas: GRID_AREAS,
};
