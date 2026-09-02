import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { applyThemeClass, UI_STORAGE_KEY } from "./lib/ui-store";
import "./index.css";

// Paint the right theme before the first render (no flash): the persisted
// store rehydrates a moment later and applies the same class again.
try {
  const raw = localStorage.getItem(UI_STORAGE_KEY);
  const theme = raw ? (JSON.parse(raw) as { state?: { theme?: "dark" | "light" } }).state?.theme : undefined;
  applyThemeClass(theme ?? "dark");
} catch {
  applyThemeClass("dark");
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
