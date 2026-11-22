// Resizable split layout of the Trade page (replaces the fixed grid). Pure data.

export interface SplitSpec {
  readonly id: string;
  readonly initial: readonly number[];
  readonly min: readonly number[];
  /** Optional per-pane minimum in px. */
  readonly minPx?: readonly number[];
}

/**
 * Outermost vertical split: panels area | console (command bar). The console's px minimum is one
 * input line; the small initial percentage always resolves to that minimum on normal windows.
 */
export const CONSOLE_SPLIT: SplitSpec = {
  id: "trade-console",
  initial: [97, 3],
  min: [50, 3],
  minPx: [0, 32],
};

/** Outer horizontal split: left column | centre | right column. */
export const MAIN_SPLIT: SplitSpec = { id: "trade-main", initial: [18, 60, 22], min: [12, 30, 14] };

/** Left column, vertical: watchlist | news | tape. */
export const LEFT_SPLIT: SplitSpec = { id: "trade-left", initial: [40, 35, 25], min: [15, 15, 10] };

/** Centre, vertical: chart | AI copilot | positions. */
export const CENTRE_SPLIT: SplitSpec = { id: "trade-centre", initial: [55, 20, 25], min: [25, 10, 12] };

/** Right column, vertical: order book | order ticket. */
export const RIGHT_SPLIT: SplitSpec = { id: "trade-right", initial: [55, 45], min: [20, 25] };

export const ALL_SPLITS: readonly SplitSpec[] = [CONSOLE_SPLIT, MAIN_SPLIT, LEFT_SPLIT, CENTRE_SPLIT, RIGHT_SPLIT];
