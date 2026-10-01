import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/hacker-theme.css";
import { initPiWebTheme } from "./theme/pi-web-theme";

// Anti-flash : les packs Pi-Web sont enregistrés dans la brique `tokens`
// (holaf-lib) et le thème mémorisé (localStorage) est posé AVANT le premier
// rendu. La brique écrit les `--holaf-*` sur :root, les variables Pi-Web
// (aliases dans hacker-theme.css) suivent automatiquement. Le registre de
// packs de la brique étant volatil, il est rejoué à chaque boot.
initPiWebTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
