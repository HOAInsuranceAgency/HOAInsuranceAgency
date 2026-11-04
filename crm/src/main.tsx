import "./configureAmplify";
import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import "./styles.css";
import App from "./App";
import { EditProtectionProvider } from "./lib/editProtection";

const router = createBrowserRouter([{ path: "*", element: <EditProtectionProvider><App /></EditProtectionProvider> }]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
