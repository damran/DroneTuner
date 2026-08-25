import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { BookOpen, MessageSquare, Plane, Radio, SlidersHorizontal, Wand2 } from "lucide-react";
import { cn } from "@/lib/utils";
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
  // Give the copilot drone context when a drone page is open.
  const droneMatch = /^\/drones\/(\d+)/.exec(location.pathname);
  const droneId = droneMatch ? Number(droneMatch[1]) : null;

  return (
    <div className="flex h-screen bg-background">
      <aside className="flex w-56 shrink-0 flex-col border-r bg-card">
        <div className="flex h-14 items-center gap-2 border-b px-4">
          <Plane className="h-5 w-5 text-primary" />
          <span className="font-semibold tracking-tight">DroneTuner</span>
        </div>
        <nav className="flex-1 space-y-1 p-2">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t p-2">
          <button
            onClick={() => setChatOpen(true)}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          >
            <MessageSquare className="h-4 w-4" />
            Ask the copilot
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl p-6">{children}</div>
      </main>
      {/* Keep the drawer mounted so the conversation survives open/close. */}
      <div className={cn(chatOpen ? "" : "hidden")}>
        <ChatDrawer droneId={droneId} onClose={() => setChatOpen(false)} />
      </div>
      <ApplyFlow />
    </div>
  );
}
