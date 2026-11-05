import "./instrument";
import "./configureAmplify";
import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import "./styles.css";
import App from "./App";
import { EditProtectionProvider } from "./lib/editProtection";
import { AppErrorBoundary, RouteErrorBoundary } from "./components/AppErrorBoundary";

const router = createBrowserRouter([{
  path: "*",
  element: <EditProtectionProvider><App /></EditProtectionProvider>,
  errorElement: <RouteErrorBoundary />,
}]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <RouterProvider router={router} />
    </AppErrorBoundary>
  </React.StrictMode>
);
