# Licences, data sources and attribution

Everything on the map is built from open data. No Google, Apple, Bing or other proprietary map content
(imagery, 3D tiles, geometry) is used, not even as a reference.

## This repository

| What | Licence |
|---|---|
| Source code (`pipeline/`, `web/`, scripts) | [MIT](LICENSE) |
| Map imagery (published tiles), `video/`, `pipeline/style/` | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) by Dmytro Krasun, **plus the data credits below**, which must be kept with any copy |

The imagery and videos are *Produced Works* under the ODbL (see OpenStreetMap below): their own licence is
free to choose, but the OpenStreetMap notice must stay with them. AI-painted images may not be protected by
copyright everywhere; where they are, CC BY 4.0 applies.

## Credit line

Shown on the map (footer), in video mode and on every clip; use it on reposts, captions and end cards:

> Map data © OpenStreetMap contributors · Tel Aviv-Yafo Municipality · Terrain: Copernicus DEM © DLR, Airbus DS · Painted with AI

Stuttgart (region `stuttgart`, rendered procedurally, not painted):

> Map data © OpenStreetMap contributors · Datenquelle: LGL, www.lgl-bw.de, dl-de/by-2-0

Each region lists its own credit lines in `pipeline/src/places.ts` (`credits`).

## Data sources

| Source | Used for | Licence | Obligations |
|---|---|---|---|
| [OpenStreetMap](https://www.openstreetmap.org/copyright) (via the Overpass API) | ground (roads, pavements, parks, beach, coastline, water, rail, landuse), buildings outside Tel Aviv-Yafo, municipal borders, roads for the traffic animation, rail routes and tracks for the trains | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) | "© OpenStreetMap contributors" visible with the map and videos. Map images and videos are Produced Works (no share-alike on them). The data the pipeline derives by joining OSM with other data is a Derivative Database: it is not redistributed, and `pipeline/` (this repository) is the published method to recreate it. |
| [Tel Aviv-Yafo Municipality GIS](https://opendatasource.tel-aviv.gov.il/) (layer 513 buildings, layer 574 tree canopy 2024) | building footprints and surveyed heights, trees in Tel Aviv-Yafo | Municipal open-data terms (the Hebrew text is binding) | Cite the source. |
| [Copernicus DEM GLO-30](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM) (AWS Open Data) | terrain height | Copernicus DEM licence: free, including commercial use | "© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved". |
| [LGL Baden-Württemberg Open GeoData](https://opengeodata.lgl-bw.de): LoD2 3D buildings (CityGML) | buildings with roof shapes in Stuttgart | [Datenlizenz Deutschland – Namensnennung 2.0](https://www.govdata.de/dl-de/by-2-0) (metadata record 3c42c386-5ba2-43e3-8e6d-2146fa99cdeb) | Credit "Datenquelle: LGL, www.lgl-bw.de, dl-de/by-2-0" with the map and videos; mark changes (the map is a derived rendering). |
| LGL Open GeoData: DGM1 (1 m digital terrain model) | terrain height in Stuttgart (Copernicus outside Baden-Württemberg) | Datenlizenz Deutschland – Namensnennung 2.0 (the portal's terms: every Open GeoData product) | Same credit line. |
| LGL Open GeoData: nDOM1 (1 m normalised surface model) | tree crown positions, sizes and heights in Stuttgart (no open city tree inventory exists) | Datenlizenz Deutschland – Namensnennung 2.0 | Same credit line. |
| Wikimedia Commons photos [Fernsehturm_stuttgart.jpg](https://commons.wikimedia.org/wiki/File:Fernsehturm_stuttgart.jpg) (Alexander Blum, [CC BY-SA 2.0 DE](https://creativecommons.org/licenses/by-sa/2.0/de/)) and [Turm_Stuttgart_Hauptbahnhof_2010-06-28_(1).jpg](https://commons.wikimedia.org/wiki/File:Turm_Stuttgart_Hauptbahnhof_2010-06-28_%281%29.jpg) (Harke, [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)) | looked at for proportions and colours of the hand-built Fernsehturm and Mercedes star models (`pipeline/src/landmarks.ts`); dimensions from de.wikipedia and OSM building:parts. No pixels are used. | CC BY-SA | Credited here; the photos are not copied, traced or redistributed. |
| Wikimedia Commons photos [Stuttgart_-_Keplerstraße_7.jpg](https://commons.wikimedia.org/wiki/File:Stuttgart_-_Keplerstra%C3%9Fe_7.jpg) (Zinnmann, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)), [Ehemalige_Trikotagenfabrik_Wilhelm_Benger_.jpg](https://commons.wikimedia.org/wiki/File:Ehemalige_Trikotagenfabrik_Wilhelm_Benger_.jpg) (A-H TSB, CC BY-SA 4.0), [Landappbw_1058706_1817_Villen_in_Heslach_Stuttgart.jpg](https://commons.wikimedia.org/wiki/File:Landappbw_1058706_1817_Villen_in_Heslach_Stuttgart.jpg) (Martin Hahn, [CC0](https://creativecommons.org/publicdomain/zero/1.0/)), [Killesberg-pjt1.jpg](https://commons.wikimedia.org/wiki/File:Killesberg-pjt1.jpg) (Pjt56, CC BY-SA 4.0), [Aerial_image_of_the_Pattonville_airfield_(view_from_the_west).jpg](https://commons.wikimedia.org/wiki/File:Aerial_image_of_the_Pattonville_airfield_(view_from_the_west).jpg) (Carsten Steger, CC BY-SA 4.0) | looked at as a vocabulary of façade details (window sizes and groupings, frames, shutters, sills, string courses, shop fronts) for the procedural façade shader (`pipeline/page/renderer.ts`), and for the asphalt and grass runways of EDTQ Pattonville. No pixels are used. | CC BY-SA / CC0 | Credited here; the photos are not copied, traced or redistributed. |
| Wikimedia Commons photos [15-01-18-Stuttgart-RalfR-DSCF1096-19_retusche.jpg](https://commons.wikimedia.org/wiki/File:15-01-18-Stuttgart-RalfR-DSCF1096-19_retusche.jpg) (Ralf Roletschek, [GFDL 1.2](https://www.gnu.org/licenses/old-licenses/fdl-1.2.html)), [Koenigsbau_Stuttgart_20060901.jpg](https://commons.wikimedia.org/wiki/File:Koenigsbau_Stuttgart_20060901.jpg) (Rosenzweig, [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)) and [StuttgartSchloss2018-05-08-15-06-56_(cropped).jpg](https://commons.wikimedia.org/wiki/File:StuttgartSchloss2018-05-08-15-06-56_(cropped).jpg) (Rolf Kickuth, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)) | looked at for the Königsbau colonnade (column count, height, depth), the materials of the Königsbau, Neues Schloss and Altes Schloss, the crown on the Schloss dome and the Jubiläumssäule (`pipeline/src/landmarks.ts` `LOOKS`, `ARCADES`, `TOPS`, `TOWERS`; the column’s height from OSM). No pixels are used. | GFDL / CC BY-SA | Credited here; the photos are not copied, traced or redistributed. |
| Wikimedia Commons photos [Stadtbahn_Stuttgart_Nordbahnhofstraße_U15_3503.JPG](https://commons.wikimedia.org/wiki/File:Stadtbahn_Stuttgart_Nordbahnhofstra%C3%9Fe_U15_3503.JPG) (Joma2411, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)) and [Mühldorf,_Doppelstock-RB-42_nach_Burghausen,_1.jpeg](https://commons.wikimedia.org/wiki/File:M%C3%BChldorf,_Doppelstock-RB-42_nach_Burghausen,_1.jpeg) (Renardo la vulpo, [CC0](https://creativecommons.org/publicdomain/zero/1.0/)) | looked at for the liveries of the animated trains (`web/src/scripts/trains.ts`): the SSB DT 8 Stadtbahn and DB double-deck regional coaches. No pixels are used. | CC BY-SA / CC0 | Credited here; the photos are not copied, traced or redistributed. |
| Wikimedia Commons photos [Neckarbruecke_(Stuttgart_21)_1X7A0049.jpg](https://commons.wikimedia.org/wiki/File:Neckarbruecke_(Stuttgart_21)_1X7A0049.jpg) and [Rosensteintunnel_(2021)_1X7A0042.jpg](https://commons.wikimedia.org/wiki/File:Rosensteintunnel_(2021)_1X7A0042.jpg) (Alexander Migl, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)), [Stuttgart_Koenig-Karls-Bruecke_Stuttgart.jpg](https://commons.wikimedia.org/wiki/File:Stuttgart_Koenig-Karls-Bruecke_Stuttgart.jpg) (MSeses, [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) / GFDL) and [Schwabtunnel-8_Westportal_Figurengruppe.jpg](https://commons.wikimedia.org/wiki/File:Schwabtunnel-8_Westportal_Figurengruppe.jpg) (Vux, [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)) | looked at for proportions and colours of the hand-built tunnel portals and bridges (`pipeline/src/portals.ts`, `pipeline/src/bridgemodels.ts`): the S21 Neckarbrücke, the Rosensteintunnel portals, the König-Karls-Brücke and the Schwabtunnel west portal; dimensions from de.wikipedia and OSM. No pixels are used. | CC BY-SA / GFDL | Credited here; the photos are not copied, traced or redistributed. |

None of this data is in the repository: `npm run fetch` downloads it into `data/` (ignored by git).

## AI painting

Render tiles are repainted by OpenAI's image model through the Codex CLI (ChatGPT account). OpenAI's terms
assign the output rights to the user. No credit is required; the map and clips say "Painted with AI" because
social platforms ask for AI-generated content to be labelled.

Everything in `pipeline/style/` was painted the same way for this project: `reference.png` (the house style,
a stretch of the painted Tel Aviv map: Gordon beach and the city behind it), `trees.png` (tree species
sheet) and `sea.png` (sea texture).

## Software

[three.js](https://threejs.org) (MIT), [OpenSeadragon](https://openseadragon.github.io) (BSD-3-Clause),
[Astro](https://astro.build) (MIT), [sharp](https://sharp.pixelplumbing.com) (Apache-2.0),
[Playwright](https://playwright.dev) (Apache-2.0), [esbuild](https://esbuild.github.io) (MIT),
[tsx](https://tsx.is) (MIT), [FFmpeg](https://ffmpeg.org) (LGPL/GPL, used as an external tool only),
[gifsicle](https://www.lcdf.org/gifsicle/) (GPL-2.0, external tool only). Installed from npm or the system package manager,
not vendored; their licences come with them.

This is not legal advice.
