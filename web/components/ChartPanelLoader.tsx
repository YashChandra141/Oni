"use client";

import dynamic from "next/dynamic";

// Req 25.5: the chart library is loaded in the browser only. In Next 16, `dynamic` with
// `ssr: false` must be called from a client component, which is why this file exists.
const ChartPanel = dynamic(() => import("./ChartPanel"), {
  ssr: false,
  loading: () => (
    <div role="status" className="flex h-full items-center justify-center text-xs text-phosphor-faint">
      loading chart…
    </div>
  ),
});

export function ChartPanelLoader() {
  return <ChartPanel />;
}

export default ChartPanelLoader;
