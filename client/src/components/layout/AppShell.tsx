import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { BookOpen, MessageSquare, Moon, Plane, Radio, SlidersHorizontal, Sun, Wand2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/lib/ui-store";
import { Switch } from "@/components/ui/switch";
import ChatDrawer from "../chat/ChatDrawer";
import ApplyFlow from "../ApplyFlow";

const nav = [
  { to: "/", label: "Fleet", icon: Plane },
  { to: "/logs", label: "Log Lab", icon: Radio },
  { to: "/profiles", label: "Profiles", icon: SlidersHorizontal },
  { to: "/wizard", label: "Tuning Wizard", icon: Wand2 },
  { to: "/guide", label: "Guide", icon: BookOpen },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [chatOpen, setChatOpen] = useState(false);
  const location = useLocation();
  const { mode, theme, setMode, setTheme } = useUiStore();
  // Give the copilot drone context when a drone page is open.
  const droneMatch = /^\/drones\/(\d+)/.exec(location.pathname);
  const droneId = droneMatch ? Number(droneMatch[1]) : null;

  return (
    <div className="flex h-screen bg-background">
      {/* Below 900 px the sidebar collapses to icons so the content keeps its width. */}
      <aside className="flex w-14 shrink-0 flex-col border-r bg-card min-[900px]:w-56">
        <div className="flex h-14 items-center justify-center gap-2 border-b px-2 min-[900px]:justify-start min-[900px]:px-4">
          <Plane className="h-5 w-5 text-primary" />
          <span className="hidden font-semibold tracking-tight min-[900px]:inline">DroneTuner</span>
        </div>
        <nav className="flex-1 space-y-1 p-2" aria-label="Main">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              title={item.label}
              className={({ isActive }) =>
                cn(
                  "flex items-center justify-center gap-2 rounded-md px-2 py-2 text-sm transition-colors min-[900px]:justify-start min-[900px]:px-3",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )
              }
            >
              <item.icon className="h-4 w-4 shrink-0" />
              <span className="hidden min-[900px]:inline">{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="space-y-1 border-t p-2">
          <label
            className="flex cursor-pointer items-center justify-center rounded-md px-2 py-2 text-sm text-muted-foreground hover:bg-accent/50 min-[900px]:justify-between min-[900px]:px-3"
            title="Advanced mode"
          >
            <span className="hidden items-center gap-2 min-[900px]:flex">
              <SlidersHorizontal className="h-4 w-4" />
              Advanced mode
            </span>
            <Switch
              checked={mode === "advanced"}
              onCheckedChange={(on) => setMode(on ? "advanced" : "simple")}
              aria-label="Toggle advanced mode"
            />
          </label>
          <button
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className={cn(
              "flex w-full items-center justify-center gap-2 rounded-md px-2 py-2 text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground min-[900px]:justify-start min-[900px]:px-3",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            )}
            aria-label="Toggle light or dark theme"
            title={theme === "dark" ? "Light theme" : "Dark theme"}
          >
            {theme === "dark" ? <Sun className="h-4 w-4 shrink-0" /> : <Moon className="h-4 w-4 shrink-0" />}
            <span className="hidden min-[900px]:inline">{theme === "dark" ? "Light theme" : "Dark theme"}</span>
          </button>
          <button
            onClick={() => setChatOpen(true)}
            className={cn(
              "flex w-full items-center justify-center gap-2 rounded-md px-2 py-2 text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground min-[900px]:justify-start min-[900px]:px-3",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            )}
            title="Ask the copilot"
          >
            <MessageSquare className="h-4 w-4 shrink-0" />
            <span className="hidden min-[900px]:inline">Ask the copilot</span>
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl p-4 min-[900px]:p-6">{children}</div>
      </main>
      {/* Keep the drawer mounted so the conversation survives open/close. */}
      <div className={cn(chatOpen ? "" : "hidden")}>
        <ChatDrawer droneId={droneId} onClose={() => setChatOpen(false)} />
      </div>
      <ApplyFlow />
    </div>
  );
}
