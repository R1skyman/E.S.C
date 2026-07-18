import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { installStorage } from "./storage.js";
import "./index.css";

installStorage();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
