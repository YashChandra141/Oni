"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NavIcon } from "./NavIcon";
import { APP_VERSION, isActive, SIDEBAR_NAV } from "./nav";

/** Left sidebar: page links with the active page as a red pill, and the version at the bottom. */
export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside
      aria-label="Sidebar"
      className="crt-panel flex w-44 shrink-0 flex-col justify-between overflow-y-auto py-2 text-sm"
    >
      <nav aria-label="Pages" className="flex flex-col gap-1 px-2">
        {SIDEBAR_NAV.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.label}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-2 rounded-full px-3 py-1.5 ${
                active
                  ? "bg-accent text-white"
                  : "text-phosphor-dim hover:bg-crt-panel hover:text-phosphor"
              }`}
            >
              <NavIcon name={item.icon} />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="px-4 pt-2 text-xs text-phosphor-faint">Oni {APP_VERSION}</div>
    </aside>
  );
}
