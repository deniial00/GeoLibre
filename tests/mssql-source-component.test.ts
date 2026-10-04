import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, createRef } from "react";
import { render, screen } from "./helpers/dom";
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

    assert.equal(
      screen.getByText("SQL Server layers are only available in GeoLibre Desktop.").textContent,
      "SQL Server layers are only available in GeoLibre Desktop.",
    );
    assert.ok(screen.getByLabelText("Server"));
    assert.ok(screen.getByLabelText("Database"));
    assert.equal(screen.getByRole("button", { name: "Connect" }).hasAttribute("disabled"), true);
  });
});
