import { Input, Label } from "@geolibre/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { createPMTilesArchiveLayers, readRemotePMTilesInfo } from "@geolibre/map/pmtiles-layer";
import { AddDataSourceForm, useAddDataSource } from "../shared";

/** Host-owned archive import for renderers without a MapLibre control container. */
export function PmtilesSource() {
  const { t } = useTranslation();
  const source = useAddDataSource(t("toolbar.item.pmtilesLayer"));
  const [url, setUrl] = useState("");
  const submit = source.runSubmit(async () => {
    const address = new URL(url.trim());
    if (!["https:", "http:"].includes(address.protocol))
      throw new Error("PMTiles requires an HTTP(S) URL");
    const info = await readRemotePMTilesInfo(address.href);
    if (info.encoding === "mlt") throw new Error("ArcGIS requires MVT vector tiles, not MLT");
    const layers = createPMTilesArchiveLayers({
      id: crypto.randomUUID(),
      name: source.layerName,
      url: address.href,
      ...info,
    });
    for (const layer of layers)
      source.shell.addLayer(
        {
          ...layer,
          source: {
            ...layer.source,
            bounds: info.bounds,
            minzoom: info.minZoom,
            maxzoom: info.maxZoom,
          },
          metadata: { ...layer.metadata, bounds: info.bounds },
        },
        source.beforeLayer,
      );
    if (info.bounds) source.shell.mapControllerRef.current?.fitBounds(info.bounds);
    source.shell.closeDialog();
  });
  return (
    <AddDataSourceForm
      layerName={source.layerName}
      onLayerNameChange={source.setLayerName}
      beforeLayerId={source.beforeLayerId}
      onBeforeLayerIdChange={source.setBeforeLayerId}
      onSubmit={submit}
      error={source.error}
      submitDisabled={source.isSubmitting || !url.trim()}
    >
      <div className="space-y-1.5">
        <Label htmlFor="pmtiles-url">{t("toolbar.item.urlLabel")}</Label>
        <Input
          id="pmtiles-url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com/archive.pmtiles"
        />
      </div>
    </AddDataSourceForm>
  );
}
