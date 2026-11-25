# Isometric World: guide for agents

Isometric city maps from open data, drawn by our own renderer and painted with AI. Read `README.md` (pipeline,
hosting, the Stuttgart and Zagreb notes) and `ATTRIBUTION.md` (sources, licences) first. Everything is TypeScript;
the site is Astro + OpenSeadragon.

## Hard rules

1. **Open data only.** Never use Google Maps/Earth/3D Tiles, Apple, Bing, Mapbox satellite or any other
   proprietary imagery or geometry, not even "just for reference" or as a style source. The project was
   rebuilt once to remove Google-derived content. If a source's licence is unclear, stop and ask.
2. **Every source gets credited.** A new data source is not done until it is in `ATTRIBUTION.md` (source,
   use, licence, obligations), in the region's `credits` in `pipeline/src/places.ts` (shown on the map's
   video mode and on social clips), and in the site's per-region links (see "The site" below).
3. **Keep the licence terms intact**: "© OpenStreetMap contributors" visible wherever the map or a video is
   shown (ODbL); Copernicus DEM text as written in `ATTRIBUTION.md`; "Painted with AI" on clips and in the
   credits of every region with painted tiles; the `pipeline/` stays published as the method to recreate the
   derived database (ODbL).
4. **Stay inside your region and the files you were asked to change.** Never re-export, repaint or publish
   another region. Never stop the user's dev server (`astro dev stop`): they keep it open while you work (any
   port; the dev server prints it). Don't touch `web/` while a film render (`pipeline/src/film.ts`) is running:
   hot reload breaks the capture.
5. **Shared code runs for every region.** `renderer.ts`, `page/ground.ts`, `ground.ts`, `scene.ts` and the paint
   assembly are global: a change shows up in every region on its next run. A new look feature is a field of the
   style presets (`pipeline/src/styles.ts`) whose value in the existing presets keeps their look; a data reader
   goes behind the region's `sources`. Check it on another region's test patch (`rothschild`, `schlossplatz`,
   `jelacic`, Wieliczka's) pixel for pixel.
6. **Never delete `data/derived/`** (renders, height passes and, above all, paintings: hours of image
   generation each) or `data/web-state/` (what is published). `data/web/` is only the unpublished cache.
   After painting, `npm run archive -- <region>` (README "Archive"); only the user decides to free local space,
   and only after `npm run archive -- <region> --verify` passes.
7. **Publishing is outward-facing**: `npm run publish` uploads to the production bucket, `npm run deploy` updates
   the live site. Run it only when the user asked for it; it asks `[y/N]` (`--yes` only with the user's
   go-ahead). **Working for a contributor** (not a maintainer of the production bucket): publish only to their
   review bucket (`TILES_BUCKET` in `.env`, README "Contributing a city"), never to `isometricworldtiles`.
8. Tile coordinates are fixed by a region's `origin` and `headingDeg`. **Never change them for a region
   that has tiles**: every tile, paint and link would move.

## Concepts

- **Region** (`REGIONS` in `pipeline/src/places.ts`): one flat map. One camera in a local East-North-Up frame
  at `origin`, one tile pyramid on R2 under `regions/<region>/` (see Hosting). Accurate for cities within ~150 km
  of the origin, which share the map and can be scrolled between.
- **City** (`CITIES` in `places.ts`): a named view into a region. `/<city-slug>` opens the region centred
  on it. Slugs are lowercase, ASCII, hyphenated (`tel-aviv-yafo`); capitalised links redirect (404 page).
- **Area** (`AREAS` in `pipeline/src/areas.ts`): a bbox the pipeline fetches, renders and paints. Belongs
  to one region; CLIs call `openArea(name)`, which switches the camera to that region. Areas of a region may
  overlap (export takes each tile from the area it lies deepest inside; paint reuses the neighbours' windows).
- **Sources** (`sources` on the region): where buildings, trees and terrain come from beyond OSM. `"tlv"`
  (Tel Aviv municipal GIS), `"lgl"` (LGL Baden-Württemberg LoD2, nDOM1 crowns, DGM1 terrain), `"zg3d"` (Zagreb's
  LoD2 model), `"gugik"` (Polish GUGiK LoD2, BDOT10k, NMT/NMPT, orthophoto), unset (OSM buildings and trees,
  Copernicus terrain).
- **Look** (`look` on the region, independent of `sources`: check data with `sources` and the look with `look`,
  never one for the other). `"styled"` (`STYLED` in `page/renderer.ts`; Zagreb too, as the input its painter
  repaints): buildings as meshes with roofs, facade and roof materials, hillshade, ink outlines, ambient
  occlusion, paper grain, species-coloured crowns, styled streets and rails. Without a 3D source, OSM footprints
  are built as meshes (gabled or hipped from `roof:shape`, heights from `height`/`building:levels`) and tree
  crowns are generated from OSM land cover, as Zagreb does for what its model lacks, so a new styled city looks
  finished without painting. Variants of the styled look are presets in `pipeline/src/styles.ts` (`style`:
  "stuttgart", the default, also Zagreb's; "poland", Wieliczka). A region is then **styled** (Stuttgart: the render
  is the map, a few patches and landmarks painted; Wieliczka), **painted** (Zagreb: every window repainted by an
  image model, the styled render wherever one isn't) or both. Tel Aviv keeps the plain render its painting was
  made from.
- **Hosting** (`pipeline/src/hosting.ts`, README "Hosting"): tiles and region data live only on R2
  (`isometricworldtiles`, `regions/<region>/` under `TILES_ORIGIN` from `.env`), never in git or
  `web/public`. `export` writes changed files to the cache `data/web/regions/<region>/`, `npm run dev` shows
  the cache over production, `publish` uploads (with the region's state, `regions/<region>/state.json`, which
  export downloads when it's missing locally) and empties the cache. A contributor who publishes a region to
  their own bucket must include `state.json`. Tiles are AVIF only: don't build a WebP fallback for a new region
  (Tel Aviv's old WebP pyramid is legacy).
- **Archive** (`pipeline/src/archive.ts`, README "Archive"): every file under `data/derived/` and `data/raw/` in
  the private bucket `isometricworld-archive`, content-addressed. `npm run pull -- <region> shared --near <lat>,<lon>`
  brings a patch to repaint; `npm run export -- <region> --partial` then rebuilds only the tiles whose sources are
  here, and `npm run archive -- <region>` uploads only what changed.

## Adding a city

### 1. Existing region or new region?

Distance from the city to the region's `origin` < ~150 km → same region (only add areas and a city entry).
Otherwise → new region.

### 2. Research (write findings down before coding)

Record URL + licence + the exact credit wording of each:

- **Buildings with heights.** Best: an open **LoD2/3D building model** (national cadastre, city 3D model:
  CityGML, MultiPatch, OBJ): real roofs instead of roofs guessed from OSM tags. Search "<city> 3D model open data",
  "LoD2", the city's GIS portal (ArcGIS REST, WFS, CKAN). Fallback: OSM `building` with `height` /
  `building:levels`. The licence must allow derivative works and publication (CC BY, ODbL, OGL, PDDL, dl-de/by,
  municipal open licences).
- **Trees.** A city tree inventory, canopy survey or surface model (nDOM/nDSM) as open data; fallback OSM
  `natural=tree` plus land cover (crowns generated by `greenery.ts`, species from `species.ts`: central European;
  another climate needs its own table). Note the dominant species: painting needs a species sheet too.
- **Terrain.** Copernicus GLO-30 covers the world. A finer open DTM (1 m) is better on hills.
- **OSM extract.** The smallest Geofabrik `.osm.pbf` that holds the region (`osmExtract`; needs osmium-tool).
  Faster and more reliable than Overpass for anything bigger than a test patch.
- **Borders.** The OSM `admin_level` of the city and its neighbours or districts (8 in most countries, 6 for a
  German Stadtkreis, 9 for Zagreb's districts), their names exactly as tagged, their relation ids (for
  `outline`) and the country's `name:en`.
- **Street grid orientation** → `headingDeg`: diagonal (~20–45°) to the main grid so two façades of every
  block show; sea or river in front or on the left if possible; hills behind the centre, not in front of it.
- **Heights of the region**: geoid undulation at the origin (EGM2008: GeographicLib `GeoidEval` or PROJ),
  typical ground level and the highest point you want on the map (see `heightBase` below).
- **Optional life on the map**: the airport runway (threshold lat/lon, true heading), a small airfield and its
  published circuit, the tram/rail operator's lines and liveries, the squares where pigeons gather.

### 3. Configure

**`places.ts` region.** Required: `title`, `origin` (the central square), `headingDeg`, `country`,
`municipalities`, `credits`, `geoidM`, `groundH` (typical ground ellipsoid height = level a.s.l. + geoid).
Optional, from the worked examples:

| Field | What it does | Example |
|---|---|---|
| `sources` | data source set (above); unset = OSM only | `"lgl"`, `"zg3d"` |
| `osmExtract` | Geofabrik extract instead of Overpass | Stuttgart, Zagreb |
| `adminLevels`, `boundariesFrom` | border overlay levels; read borders from the extract | Stuttgart `["6","8"]`, Zagreb `["9"]` + `"extract"` |
| `outline` | map shape: OSM boundary relations + boxes (airport), optional `clip`; only tiles inside are fetched and rendered, the edge fades along it | Stuttgart, Zagreb |
| `heightBase` | the height pass stores 655 m above `heightBase - 100`: raise it in hilly regions so valleys and towers fit; clip the outline where the ground climbs out of range | Stuttgart 250, Zagreb 200 |
| `airport` | airliners on final; with `ground` they taxi, park and take off | Stuttgart (with ground), Zagreb |
| `airfield` | light aircraft: departures, arrivals, circuits | Stuttgart (Pattonville) |
| `rail` | rolling stock and intervals (default: Stuttgart Stadtbahn/DB looks; `"zet"`: Zagreb trams, HŽPP, funicular) | Zagreb |
| `pigeons` | squares the pigeon flocks circle over | Stuttgart, Zagreb |
| `signs` | rotating rooftop signs | Stuttgart (Bonatzbau star) |

New liveries or a new animal mean code in `web/src/scripts/` (`trains.ts`, `sky.ts`; Tel Aviv's parakeets are
switched on by region id in `map.ts`).

**`places.ts` city**: `title`, `region`, `center`, `widthM` (opening view).

**`areas.ts`**: start with a ~1 km test patch (`rothschild`, `schlossplatz`, `jelacic`), then cover the city in
overlapping areas of ≤ ~150 km² (bigger ones run out of memory in `scene`/`render`; split tall strips).

**New data sources** go behind the region's `sources` in `fetch.ts`, `ground.ts` and `scene.ts`, with a
reader module like `lgl.ts`/`lod2.ts` or `zg3d.ts`. Never assume another region's files exist. A new `sources`
value also needs its line in `render.ts` `ATTRIBUTIONS`, and decides in `scene.ts` (`LOD2`, `OSM_MESH`) which
buildings and trees come from it and which from OSM.

### 4. Look

**Styled** (`look: "styled"`, a preset in `styles.ts`). The renderer picks a facade style per building (`scene.ts` → `kind = 10 + style`):
shared styles 0 old plaster, 1 post-war, 2 public/sandstone, 3 tower, 4 shed, 5 office; 6 Zagreb's prefab slabs
and 7–10 its landmarks (compiled with `#define ZG`), elsewhere 6 monumental walls (preset `monumental`); 11
masonry (`portals.ts`), 12 multi-storey car park (ALKIS). A region's own styles take the next free numbers, behind
their own define or preset field, so other regions never change. OSM `roof:colour`/`roof:material`
and `building:colour`/`building:material` refine roofs and walls. Tree crowns: a species table
(`species.ts`, used by Zagreb and OSM-only regions; species from OSM tags or the place: street, park, wood). Named landmarks the data gets wrong:
`landmarks.ts` (`LOOKS` tag fixes, `PAINT` colours, `ARCADES`, hand-built models like the Fernsehturm).

**Painted.** The look comes from repainting every 1024 px window of the render with an image model, not from
the render itself (flat massing and aerial photos were both rejected).

- **Prompt per region**: add the region to `LOCAL` in `pipeline/src/paint.ts` (paint refuses to run without
  it): what the ground shows, the render's colour code, local materials, the tree sheet. `inventionChecks: true`
  refuses windows with invented roofs or invented detail (tuned on Zagreb; check on your paintings first).
- **Backends**: the Codex CLI (`codex exec`, logged in with a ChatGPT account; `CODEX_MODEL` picks the model),
  or fal.ai (`PAINT_BACKEND=fal`, `FAL_KEY`, `-j` windows at once, cost logged and capped by
  `PAINT_BUDGET_USD`, model via `PAINT_FAL_ENDPOINT`; `.env.example`). Don't add an OpenAI API key unless the
  user asks. Another provider is fine only if its terms give you the output rights and allow publication
  (record it in `ATTRIBUTION.md`).
- **Inputs per window**: the render, the height pass (keeps buildings where they are), the style reference
  `pipeline/style/reference.png` (`--look simple`: `reference-simple.png`) and the region's tree sheet
  (`style/trees.png` Tel Aviv, `trees-stuttgart.png` central Europe). Painted neighbours' edge strips are copied
  in so seams continue. A new climate (desert, snow, northern trees) needs its own tree sheet; keep
  `reference.png` as the one house style.
- **Keep the geometry**: the prompt asks for the same buildings, streets and coastline in the same places;
  `paint.ts` checks each result against the render, warps it back if it drifted and repaints windows with
  black bands or patches. Never accept a painting that invents or moves streets. Don't name landmarks in the
  regional prompt (the model paints them into every window); `FACADES` adds a facade note only to the windows a
  building falls in.
- **Assembly** (every region): one colour offset per window so neighbours agree, then a seam cut along the
  least-different path through each overlap; tiles only some windows cover fade into the render.
- **Landmarks** (a fair, a stadium, a palace): never window by window (each window invents its own, and LoD2
  massing gets painted literally). `npm run landmark -- <area> <name> overview|edit|key`
  (`pipeline/src/landmark.ts`, prompts and the recipe of each in `pipeline/landmarks/`): one coherent painting,
  reviewed with the user, box edits, then a magenta chroma-key cut-out as the mask; `cutout.ts` composes it,
  export keeps traffic off it. Reference photos: open licence only (PD/CC0/CC BY as images, CC BY-SA as text),
  credited in `ATTRIBUTION.md`.
- **From aerial photos**: where an open orthophoto exists, drape it with `aerial.ts` and paint with
  `--aerial <source> --aerial-input` (README "Stuttgart"); credit the photos like any source. Use `--tag` for
  experiments so nothing reaches `paint/`.
- **Order**: paint a small test patch first, review it with the user, then the rest (`--center` picks where the
  rings start). A whole city takes many hours; run it in the background and re-export as you go
  (`pipeline/watch-export.sh`), previewing with `npm run dev`.

### 5. The site

Per-region tables to extend for a new region (until they move into `places.ts`):

- `web/src/scripts/map.ts`: the footer's source links and "Made by" line (`REGION === …`).
- `web/src/pages/index.astro`: `PEOPLE` (makers), `SOURCES` (links), `PAINTED`.
- `pipeline/src/film.ts` `FILMS` (shots per city) and `pipeline/src/tour.ts` `PLACES` (screenshot spots).

### 6. Run (per area; see README for flags)

```sh
npm -w pipeline run boundaries -- <region>   # new region only
npm run fetch -- <area>
npm run ground -- <area>
npm run scene -- <area>
npm run render -- <area> -j 2
npm run paint -- <area> --center <lat>,<lon>  # painted regions; slow: paint the test patch first and review it
npm run export -- <all areas of the region>   # changed tiles into data/web (cache)
npm run dev                                    # check the cache over production (http://localhost:<port>/)
npm run og -- <city-slug>                      # social card web/public/og/<city-slug>.jpg from the tiles (commit it)
npm run publish -- <region>                    # only with the user's go-ahead; contributors: to a review bucket (README "Contributing a city")
npm run deploy                                 # after every publish: pages bake in world.json's file names + preview
```

One area from `ground` to `export` takes ~15 min; a whole city overnight. After a change to scene or render
code, rebuild per area, not the region at once. `--parts` (README "Fixing a few buildings") keeps a fix small.

### 7. Check

- Open `http://localhost:<port>/<city-slug>` (the dev server prints the port): centred on the city, no console
  errors, borders (`B`), traffic (`T`), raw render (`P`), credits correct. `?at=lat,lon,km` and `#metro` work.
- `npm -w pipeline exec tsx src/tour.ts` (with your `PLACES`) for screenshots; look at them.
- `npm -w pipeline exec tsx src/traffictest.ts` for jams and overlaps on the new road network.
- Typecheck: `cd pipeline && ../node_modules/.bin/tsc --noEmit -p .` and the same in `web/`.

## Social clips

`pipeline/src/film.ts` renders a deterministic clip from the running site (square 1080, 60 fps, poses +
eased moves, crisp (`--blur 8` for motion blur), light grain, city name fading in at the end, credits always
visible). Add the city's shots to its `FILMS` (render with `--city <slug>`, another shot list with `--film`),
check with `--preview`, then render (~1 h). Output goes to `video/<city-slug>.mp4`; the GitHub GIF is made from a
landscape render (`--size 960x540 --fps 30 --grain 0`), 2.5× faster, 480 px, 12 fps, ffmpeg palette +
`gifsicle --lossy` (keep it ≲ 4 MB). `beforeafter.ts` wipes production against the dev cache.
