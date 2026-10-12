import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Window } from "happy-dom";
import { createIdentifyPopupRows } from "../packages/map/src/feature-popup";

const original = {
  window: globalThis.window,
  document: globalThis.document,
  DOMParser: globalThis.DOMParser,
  Node: globalThis.Node,
  Element: globalThis.Element,
  HTMLAnchorElement: globalThis.HTMLAnchorElement,
  HTMLElement: globalThis.HTMLElement,
};
afterEach(() => Object.assign(globalThis, original));

function withDocument() {
  const window = new Window();
  const document = window.document;
  Object.assign(globalThis, {
    window,
    document,
    DOMParser: window.DOMParser,
    Node: window.Node,
    Element: window.Element,
    HTMLAnchorElement: window.HTMLAnchorElement,
    HTMLElement: window.HTMLElement,
  });
  return document;
}

const inlineImage =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("identify popup content policy", () => {
  it("keeps the default image and link rendering intact", () => {
    withDocument();
    const rows = createIdentifyPopupRows(
      {
        photo: "https://images.example/photo.png",
        site: "https://example.org",
        inline: inlineImage,
      },
      undefined,
      {
        popup: {
          fields: [
            { field: "photo", kind: "image" },
            { field: "site", kind: "link" },
          ],
        },
      },
    );
    assert.equal(rows.querySelectorAll("img").length, 1);
    assert.equal(
      rows.querySelector("a[href='https://example.org']")?.textContent,
      "https://example.org",
    );
  });

  it("renders resolved values and KML structure without images or navigable anchors", () => {
    withDocument();
    const rows = createIdentifyPopupRows(
      {
        photo: "https://images.example/photo.png",
        site: "https://example.org",
        description:
          '<p>Read <a href="https://example.net" target="_blank">more</a><img src="https://evil.example/x.png"></p>',
        secret: "hidden",
        price: 12.5,
        inline: inlineImage,
      },
      undefined,
      {
        contentPolicy: "text-only",
        popup: {
          fields: [
            { field: "secret", label: "Secret" },
            { field: "photo", label: "Photo", kind: "image" },
            { field: "site", label: "Website", kind: "link", format: { linkLabel: "Visit" } },
            { field: "description", label: "Description" },
            {
              field: "price",
              label: "Price",
              kind: "number",
              format: { decimals: 1, prefix: "$" },
            },
            { field: "inline", label: "Inline" },
          ],
        },
        fieldVisibility: { secret: "hidden" },
      },
    );
    assert.equal(rows.querySelectorAll("img").length, 0);
    assert.equal(rows.querySelectorAll("a[href], a[target]").length, 0);
    assert.equal(rows.querySelector(".geolibre-kml-description p")?.textContent, "Read more");
    assert.equal(rows.textContent?.includes("https://example.org"), true);
    assert.equal(rows.textContent?.includes("$12.5"), true);
    assert.equal(rows.textContent?.includes("hidden"), false);
    assert.equal(rows.querySelectorAll(".geolibre-identify-popup-row").length, 5);
    assert.equal(rows.querySelector(".geolibre-identify-popup-label")?.tagName, "DT");
    assert.equal(rows.querySelector(".geolibre-identify-popup-value")?.tagName, "DD");
  });
});
