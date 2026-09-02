import { create } from "zustand";
import { persist } from "zustand/middleware";

export type UiMode = "simple" | "advanced";
export type Theme = "dark" | "light";

interface UiState {
  /** Simple hides raw parameter tables, rule internals and per-stage delay maths. */
  mode: UiMode;
  theme: Theme;
  setMode: (mode: UiMode) => void;
  setTheme: (theme: Theme) => void;
}

export const UI_STORAGE_KEY = "dronetuner-ui";

/** Apply the theme class to <html> (Tailwind darkMode: "class"). */
export function applyThemeClass(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      mode: "simple",
      theme: "dark",
      setMode: (mode) => set({ mode }),
      setTheme: (theme) => {
        applyThemeClass(theme);
        set({ theme });
      },
    }),
    {
      name: UI_STORAGE_KEY,
      onRehydrateStorage: () => (state) => {
        if (state) applyThemeClass(state.theme);
      },
    },
  ),
);

/** Convenience: true when expert details should be shown. */
export function useAdvanced(): boolean {
  return useUiStore((s) => s.mode === "advanced");
}
