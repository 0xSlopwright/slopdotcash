/**
 * Boots the contribution surface in the browser. The project registry lives
 * in D1, so it loads before the app module and its project lookups evaluate.
 */

import "@fontsource-variable/bricolage-grotesque/opsz.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import { type ComponentType, StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./ErrorBoundary";
import {
  installProjectRegistry,
  loadProjectRegistry,
} from "./lib/project-registry-boot";
import "./brand-tokens.css";
import "./styles.css";
import "./design-system.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("[Slop] #root is missing");
}

// The fundraising deck was retired on 10 Sep 2026. The reviewed
// deck.slop.cash Pages domain still serves this bundle, so send visitors home.
if (window.location.hostname === "deck.slop.cash") {
  window.location.replace("https://slop.cash/");
}

type BootState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; App: ComponentType };

function RegistryBoot() {
  const [state, setState] = useState<BootState>({ status: "loading" });
  useEffect(() => {
    let active = true;
    loadProjectRegistry()
      .then(async (projects) => {
        installProjectRegistry(projects);
        try {
          const { App } = await import("./App");
          return App;
        } catch (error) {
          // error-policy:J1 an invalid registry is a visible error, never an empty list.
          console.error(error);
          throw new Error("The project registry did not pass validation.");
        }
      })
      .then(
        (App) => {
          if (active) setState({ status: "ready", App });
        },
        (error: unknown) => {
          if (active)
            setState({
              status: "error",
              message:
                error instanceof Error
                  ? error.message
                  : "The project registry could not be read.",
            });
        },
      );
    return () => {
      active = false;
    };
  }, []);
  if (state.status === "ready") return <state.App />;
  return (
    <main className="shell route-main boot-state">
      {state.status === "loading" ? (
        <p role="status">Loading projects…</p>
      ) : (
        <div role="alert">
          <h1>Projects are unavailable</h1>
          <p>{state.message} No project list is shown until it loads.</p>
          <button
            className="button primary-button"
            onClick={() => window.location.reload()}
            type="button"
          >
            Try again
          </button>
        </div>
      )}
    </main>
  );
}

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <RegistryBoot />
    </ErrorBoundary>
  </StrictMode>,
);
