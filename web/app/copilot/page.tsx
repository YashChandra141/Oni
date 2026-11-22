"use client";

import Link from "next/link";
import { CopilotPanel } from "../../components/CopilotPanel";

export default function CopilotPage() {
  return (
    <main className="mx-auto flex h-full max-w-3xl flex-col gap-2 overflow-auto p-4">
      <header className="flex items-center justify-between">
        <h1 className="crt-title text-lg">AI Copilot</h1>
        <Link href="/" className="text-xs underline">
          Back to terminal
        </Link>
      </header>
      <section aria-label="AI Copilot" className="crt-panel p-3">
        <CopilotPanel large showHistory />
      </section>
    </main>
  );
}
