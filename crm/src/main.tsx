import "./configureAmplify";
import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import "./styles.css";
import "./ui.css";
import App from "./App";
import { DirtyFormsProvider } from "./components/ui/unsaved";

const router = createBrowserRouter([{ path: "*", element: <DirtyFormsProvider><App /></DirtyFormsProvider> }]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
