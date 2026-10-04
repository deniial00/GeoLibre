import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, createRef } from "react";
import { setSidecarAuthToken } from "@geolibre/processing";
import { fireEvent, mockFetch, render, screen, waitFor } from "./helpers/dom";
import { resetMssqlSessions } from "../apps/geolibre-desktop/src/lib/mssql-sessions";
import type { AddDataShellContextValue } from "../apps/geolibre-desktop/src/components/layout/add-data/context";

const [{ MssqlSource }, { AddDataShellProvider }] = await Promise.all([
  import("../apps/geolibre-desktop/src/components/layout/add-data/sources/MssqlSource"),
  import("../apps/geolibre-desktop/src/components/layout/add-data/context"),
]);

function renderMssqlSource() {
  const shell: AddDataShellContextValue = {
    mapControllerRef: createRef(),
    addLayer: () => {},
    existingLayers: [],
    isSubmitting: false,
    setIsSubmitting: () => {},
    closeDialog: () => {},
    targetGroupId: null,
    martin: {
      server: null,
      setServer: () => {},
      sources: [],
      setSources: () => {},
      selectedSourceId: "",
      setSelectedSourceId: () => {},
      status: null,
      setStatus: () => {},
      markLayerAdded: () => {},
      resetOnOpen: () => {},
      stopTransient: () => {},
    },
  };
  return render(createElement(AddDataShellProvider, { value: shell }, createElement(MssqlSource)));
}

describe("MssqlSource", () => {
  it("explains the desktop-only constraint and disables connecting in the web app", () => {
    renderMssqlSource();

    const notice = "SQL Server layers are only available in GeoLibre Desktop.";
    assert.equal(screen.getByText(notice).textContent, notice);
    assert.ok(screen.getByLabelText("Server"));
    assert.ok(screen.getByLabelText("Database"));
    assert.equal(screen.getByRole("button", { name: "Connect" }).hasAttribute("disabled"), true);
  });

  it("clears authentication-specific values when the method changes", () => {
    renderMssqlSource();

    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "stale-user" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "stale-password" } });
    const method = screen.getByLabelText("Authentication");
    fireEvent.change(method, { target: { value: "entra_sp" } });
    fireEvent.change(screen.getByLabelText("Tenant ID"), { target: { value: "tenant" } });
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "client" } });
    fireEvent.change(screen.getByLabelText("Client secret"), {
      target: { value: "stale-secret" },
    });
    fireEvent.change(method, { target: { value: "token" } });
    fireEvent.change(screen.getByLabelText("Access token"), {
      target: { value: "stale-token" },
    });
    fireEvent.change(method, { target: { value: "entra_sp" } });

    assert.equal((screen.getByLabelText("Tenant ID") as HTMLInputElement).value, "");
    assert.equal((screen.getByLabelText("Client ID") as HTMLInputElement).value, "");
    assert.equal((screen.getByLabelText("Client secret") as HTMLInputElement).value, "");
    fireEvent.change(method, { target: { value: "sql" } });
    assert.equal((screen.getByLabelText("Username") as HTMLInputElement).value, "");
    assert.equal((screen.getByLabelText("Password") as HTMLInputElement).value, "");
    fireEvent.change(method, { target: { value: "token" } });
    assert.equal((screen.getByLabelText("Access token") as HTMLInputElement).value, "");
  });

  it("disconnects a session when table discovery fails after connect", async () => {
    const tauriWindow = window as Window & {
      __TAURI_INTERNALS__?: { invoke: (command: string) => Promise<unknown> };
    };
    const previous = tauriWindow.__TAURI_INTERNALS__;
    Object.defineProperty(tauriWindow, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        invoke: async (command: string) => {
          assert.equal(command, "start_geolibre_sidecar");
          return { baseUrl: "http://127.0.0.1:8765", port: 8765, token: "test-token" };
        },
      },
    });
    resetMssqlSessions();
    const requests: string[] = [];
    mockFetch(async (input, init) => {
      const url = new URL(String(input));
      requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname.endsWith("/mssql/status")) {
        return new Response(
          JSON.stringify({ available: true, auth_methods: ["sql"], message: "" }),
          { status: 200 },
        );
      }
      if (url.pathname.endsWith("/mssql/connect")) {
        return new Response(JSON.stringify({ session_id: "session-1" }), { status: 200 });
      }
      if (url.pathname.endsWith("/mssql/tables")) {
        return new Response(JSON.stringify({ detail: "Table discovery denied" }), { status: 403 });
      }
      if (url.pathname.endsWith("/mssql/disconnect")) {
        return new Response("{}", { status: 200 });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });

    try {
      renderMssqlSource();
      fireEvent.change(screen.getByLabelText("Server"), { target: { value: "db.example" } });
      fireEvent.change(screen.getByLabelText("Database"), { target: { value: "gis" } });
      fireEvent.change(screen.getByLabelText("Username"), { target: { value: "user" } });
      fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password" } });
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));

      await waitFor(() => {
        assert.equal(requests.filter((request) => request.endsWith("/mssql/disconnect")).length, 1);
      });
    } finally {
      resetMssqlSessions();
      setSidecarAuthToken(null);
      if (previous === undefined) {
        delete tauriWindow.__TAURI_INTERNALS__;
      } else {
        Object.defineProperty(tauriWindow, "__TAURI_INTERNALS__", {
          configurable: true,
          value: previous,
        });
      }
    }
  });
});
