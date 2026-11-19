import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles/app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { router } from "./app/router";
import { AuthProvider } from "./auth/AuthProvider";
import { apiMock } from "./lib/config";

async function start() {
  if (apiMock) {
    const { installMockApi } = await import("./mocks/mockApi");
    installMockApi();
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </StrictMode>,
  );
}

void start();
