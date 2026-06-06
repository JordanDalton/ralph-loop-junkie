import React from "react";
import ReactDOM from "react-dom/client";
import "@cloudflare/kumo/styles/standalone";
import "./style.css";
import App from "./App";

document.documentElement.setAttribute("data-mode", "dark");
document.body.setAttribute("data-mode", "dark");

ReactDOM.createRoot(document.getElementById("app")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
