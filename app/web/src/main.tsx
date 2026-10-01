import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./theme.css";

// Dark by default; follow the OS when it asks for light.
const light = window.matchMedia("(prefers-color-scheme: light)");
const applyTheme = () => {
  const theme = light.matches ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#f1f1f4" : "#0f0f12");
};
applyTheme();
light.addEventListener("change", applyTheme);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
