import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/hacker-theme.css";
import { initPiWebTheme } from "./theme/pi-web-theme";

// Anti-flash : le thème mémorisé (localStorage) est posé AVANT le premier
// rendu, en appliquant le preset `<famille>-<mode>` de la brique `tokens`
// (holaf-lib) — défaut `matrix-dark`. La brique écrit les `--holaf-*` sur :root,
// les variables Pi-Web (aliases dans hacker-theme.css) suivent automatiquement.
initPiWebTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
