import { lazy } from "react";
import { createBrowserRouter } from "react-router";
import { CALLBACK_PATH } from "../auth/AuthProvider";
import { AuthCallback } from "../pages/AuthCallback";
import { Home } from "../pages/Home";
import { NotFound } from "../pages/NotFound";
import { Privacy } from "../pages/Privacy";
import { Run } from "../pages/Run";
import { RunStatus } from "../pages/RunStatus";
import { Layout } from "./Layout";

// KaTeX and markdown-it load only with the methodology.
const Methodology = lazy(() => import("../pages/Methodology"));

export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <Home /> },
      { path: "/run", element: <Run /> },
      { path: "/runs/:id", element: <RunStatus /> },
      { path: "/methodology", element: <Methodology /> },
      { path: "/privacy", element: <Privacy /> },
      { path: CALLBACK_PATH, element: <AuthCallback /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
