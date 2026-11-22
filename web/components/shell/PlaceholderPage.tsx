// Simple page body for routes that later tasks fill (Task 14.10 and others).

export function PlaceholderPage({ title, note }: { title: string; note?: string }) {
  return (
    <section aria-label={title} className="crt-panel flex h-full min-h-0 flex-col">
      <h1 className="crt-title border-b border-crt-line px-2 py-1 text-xs">{title}</h1>
      <div className="min-h-0 flex-1 overflow-auto p-4 text-sm text-phosphor-dim">
        {note ?? "Not ready yet. This page is filled in by a later task."}
      </div>
    </section>
  );
}
