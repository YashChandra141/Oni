import type { ReactNode } from "react";

/** Shared frame for the simple pages (Task 14.10): Oni panel with a title and a scrolling body. */
export function PageFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="crt-panel flex h-full min-h-0 flex-col">
      <h1 className="crt-title border-b border-crt-line px-2 py-1 text-xs">{title}</h1>
      <div className="min-h-0 flex-1 overflow-auto p-3 text-sm">{children}</div>
    </section>
  );
}

/** A label and value row. */
export function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 px-1 py-0.5 text-xs">
      <dt className="text-phosphor-dim">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

/** "Coming soon" body for pages that are not built. */
export function ComingSoon({ title, note }: { title: string; note: string }) {
  return (
    <PageFrame title={title}>
      <p className="text-amber">Coming soon</p>
      <p className="mt-1 text-xs text-phosphor-dim">{note}</p>
    </PageFrame>
  );
}
