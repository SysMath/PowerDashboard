"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../lib/cn";
import { THEME_STORAGE_KEY as KEY } from "../lib/theme-init";

export type Theme = "light" | "dark" | "system";

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export function ThemeToggle({
  labels,
  ariaLabel = "Thème",
  className,
}: {
  /** Libellés des trois modes, pour les applications traduites. */
  labels?: { light?: string; dark?: string; system?: string };
  ariaLabel?: string;
  className?: string;
}) {
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    try {
      const t = localStorage.getItem(KEY) as Theme | null;
      if (t) setTheme(t);
    } catch {}
  }, []);
  const set = (t: Theme) => {
    setTheme(t);
    applyTheme(t);
    try {
      localStorage.setItem(KEY, t);
    } catch {}
  };
  const opts: { v: Theme; icon: React.ReactNode; label: string }[] = [
    { v: "light", icon: <Sun />, label: labels?.light ?? "Clair" },
    { v: "dark", icon: <Moon />, label: labels?.dark ?? "Sombre" },
    { v: "system", icon: <Monitor />, label: labels?.system ?? "Système" },
  ];
  return (
    <div
      className={cn(
        "inline-flex h-10 items-center gap-0.5 rounded-field border border-border bg-surface p-1",
        className,
      )}
      role="toolbar"
      aria-label={ariaLabel}
    >
      {opts.map((o) => (
        <button
          key={o.v}
          type="button"
          aria-pressed={theme === o.v}
          title={o.label}
          onClick={() => set(o.v)}
          className={cn(
            "inline-flex size-7 cursor-pointer items-center justify-center rounded-xs text-muted transition-colors [&_svg]:size-4",
            theme === o.v ? "bg-accent-soft text-accent" : "hover:text-fg",
          )}
        >
          {o.icon}
        </button>
      ))}
    </div>
  );
}
