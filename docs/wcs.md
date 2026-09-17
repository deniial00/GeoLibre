# Web Coverage Service (WCS)

Use **Add Data > WCS Layer** to download numerical raster data from an OGC
Web Coverage Service. Unlike a rendered WMS image, the returned GeoTIFF retains
band values for pixel inspection, raster styling, export, and raster analysis.

1. Enter the service's WCS endpoint and click **Retrieve coverages**.
2. Select a coverage. Choose **Use view**, **Use coverage extent**, or enter
   west, south, east, and north in longitude/latitude degrees.
3. Set the output width and height in pixels and click **Add layer**.
4. Use the layer's pixel inspector or raster tools. Export the raster as a
   GeoTIFF to keep a copy of the downloaded data.

The sample selector includes USGS 3DEP elevation and the Illinois statewide
LiDAR DEM. Each sample selects a small area near Elkhart, Illinois. A bare
ArcGIS ImageServer REST URL is also accepted and converted to its WCS endpoint.
This is a convenience; GeoServer and other WCS endpoints use the same protocol.

## Supported requests

The initial implementation supports **WCS 1.0.0** KVP `GetCapabilities`,
`DescribeCoverage`, and `GetCoverage`. Services must advertise GeoTIFF output
and EPSG:4326 for both the request and response. Unsupported versions, formats,
and coordinate systems produce an error before the coverage download. WCS 1.1
and 2.x requests are not yet implemented.

The selected extent and pixel dimensions determine output resolution. The
server may resample values; this is not a guarantee of native-resolution data.
Each dimension must be 1–4096 pixels, with a 128 MB download limit. The server
may impose smaller limits. Areas crossing the antimeridian must be split into
two requests. Each load is a fixed subset; panning does not fetch more coverage.

Downloads become file-backed raster layers and follow the same persistence
rules as other imported GeoTIFFs. Export the raster before ending the session;
saving only the project does not retain the downloaded raster bytes.

Desktop requests use native HTTP. The hosted web app requires the service to
allow browser cross-origin requests (CORS). Development uses the existing
service proxy, so a successful development test alone does not establish CORS
support on the hosted site.

References: [OGC WCS 1.0.0 conformance tests](https://cite.opengeospatial.org/teamengine/about/wcs/1.0.0/site/testreq.html)
and [GeoServer WCS documentation](https://docs.geoserver.org/main/en/user/services/wcs/reference/).
