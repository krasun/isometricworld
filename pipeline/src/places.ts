/**
 * Regions and cities of Isometric World. Pure data, shared by the pipeline and the web viewer.
 *
 * A REGION is one flat map: one orthographic camera in a local East-North-Up frame at its origin,
 * one tile pyramid (web/public/regions/<id>/). A flat map is accurate to ~1° of building lean at
 * 100 km from its origin, so a region can hold all cities within ~150 km and you scroll between them.
 * Far-apart cities get their own region (joined later by a world overview).
 *
 * A CITY is a named view into a region: /<city-slug> opens the region centred on it.
 */

export interface Region {
  title: string;
  /** ENU origin. Fixed forever once tiles exist: changing it moves every tile of the region. */
  origin: { lat: number; lon: number; h: number };
  /** Compass bearing the camera looks toward (pick it diagonal to the main street grid). */
  headingDeg: number;
  /** OSM country (name:en of the admin_level=2 area) and municipality names (admin_level=8) for the border overlay. */
  country: string;
  municipalities: string[];
  /** admin_level values of the border overlay's municipalities (default ["8"]; a city-county like Stuttgart is 6). */
  adminLevels?: string[];
  /**
   * Where `boundaries` reads the borders: Overpass (default), or the region's `osmExtract`. The extract only
   * holds what Geofabrik cut: use it when every municipality lies well inside it (Croatia for Zagreb).
   */
  boundariesFrom?: "overpass" | "extract";
  /**
   * Airliners on final approach drawn over the map (optional): runway threshold, true heading,
   * threshold ellipsoid height (default 0) and the stretch drawn in metres before the threshold
   * (default 22000 → 7000; negative = past it, on the runway), and optionally braking after touchdown (m/s²;
   * default none: the plane rolls on at approach speed). web/src/scripts/sky.ts.
   */
  airport?: { lat: number; lon: number; runwayHeadingDeg: number; h?: number; from?: number; to?: number; brake?: number };
  /**
   * Local rolling stock for the animated trains (export.ts exportTrains, web/src/scripts/trains.ts). Unset: route=tram
   * lines run as Stadtbahn (kind 0) in Stuttgart's SSB and DB looks. "zet": route=tram lines are street trams
   * (kind 4: ZET TMK 2200 and ČKD T4 sets at city speeds), mainline trains in HŽPP colours, and the funiculars
   * (railway=funicular, no route relation) shuttle their cars (kind 5). `night`: refs of night-only lines, left
   * out (the map shows the day); `interval`: minutes between trams of a line (default `tramInterval`).
   * `mainline`: where route relations are single trains rather than lines (HŽPP: "Vlak 983"), refs matching `line`
   * are lines running every `every` min, the others single trains `single` min apart (a few a day: rarely seen).
   */
  rail?: {
    stock: "zet"; tramInterval: number; interval?: Record<string, number>; night?: string[];
    mainline?: { line: string; every: number; single: number };
  };
  /** Squares the pigeon flocks wheel over (web/src/scripts/sky.ts Pigeons), lat/lon; Tel Aviv has its parakeets instead. */
  pigeons?: Array<[number, number]>;
  /** Credit lines (video mode and footer). */
  credits: string[];
  /** Geoid undulation at the origin (EGM2008, m): sea level as ellipsoid height. */
  geoidM: number;
  /** Typical ground ellipsoid height (m): area outlines and the first guess before the terrain is known. */
  groundH: number;
  /**
   * Ellipsoid height (m) the height pass counts from: it stores 0…655 m above `heightBase - 100`
   * (cm, 16 bit), so a hilly region shifts it to keep its valleys and towers in range. Default 0.
   */
  heightBase?: number;
  /**
   * Where buildings, trees and terrain come from beyond OSM:
   *   "tlv"  Tel Aviv-Yafo municipal GIS (buildings + canopy), Copernicus GLO-30 terrain
   *   "lgl"  LGL Baden-Württemberg open data: LoD2 buildings, nDOM1 tree crowns, DGM1 terrain
   *   "zg3d" City of Zagreb ZG3D 2022 LoD2 buildings (zg3d.ts), OSM trees, Copernicus GLO-30 terrain
   *   unset  OSM buildings and trees, Copernicus GLO-30 terrain
   */
  sources?: "tlv" | "lgl" | "zg3d";
  /** OSM from this Geofabrik .osm.pbf extract (osmlocal.ts) instead of the Overpass API. */
  osmExtract?: string;
  /**
   * Shape of the map (outline.ts): the union of OSM boundary relations (from `osmExtract`) plus extra
   * boxes [s, w, n, e]. Only tiles inside are fetched and rendered, and the map edge fades along its
   * outer border (not along borders between the relations). Default: the areas' bboxes.
   */
  outline?: {
    relations: number[];
    add?: Array<[number, number, number, number]>;
    /** Box [s, w, n, e] the relations are cut to (a mountain beyond the height pass's range stays out). */
    clip?: [number, number, number, number];
  };
}

export interface City {
  title: string;
  region: string;
  /** Opening view: centre and on-screen width in metres. */
  center: [number, number];
  widthM: number;
}

export const REGIONS: Record<string, Region> = {
  "israel-center": {
    title: "Israel · Center",
    origin: { lat: 32.0778, lon: 34.774, h: 0 }, // Dizengoff Square
    headingDeg: 340, // 20° west of north: diagonal to Tel Aviv's grid, sea on the left
    country: "Israel",
    municipalities: [
      "תל־אביב–יפו", // maqaf + en dash, as in OSM relation 1382494
      "רמת גן",
      "גבעתיים",
      "בני ברק",
      "חולון",
      "בת ים",
      "הרצליה",
      "רמת השרון",
      "פתח תקווה",
      "קריית אונו",
      "אור יהודה",
      "גבעת שמואל",
    ],
    airport: { lat: 32.0055, lon: 34.8854, runwayHeadingDeg: 117 }, // Ben Gurion, runway 12
    credits: [
      "Map data © OpenStreetMap contributors · Tel Aviv-Yafo Municipality",
      "Terrain: Copernicus DEM © DLR, Airbus DS · Painted with AI",
    ],
    geoidM: 19.1,
    groundH: 25,
    sources: "tlv",
  },
  stuttgart: {
    title: "Stuttgart",
    origin: { lat: 48.7784, lon: 9.18, h: 0 }, // Schlossplatz
    headingDeg: 257, // looks WSW from the Neckar side, where the Kessel opens; main grid (Königstraße, 212°) at 45°
    country: "Germany",
    municipalities: [
      "Stuttgart", "Fellbach", "Kernen im Remstal", "Esslingen am Neckar", "Ostfildern", "Neuhausen auf den Fildern",
      "Filderstadt", "Leinfelden-Echterdingen", "Sindelfingen", "Leonberg", "Gerlingen", "Ditzingen",
      "Korntal-Münchingen", "Kornwestheim", "Remseck am Neckar", "Waiblingen", "Ludwigsburg", "Böblingen",
    ],
    adminLevels: ["6", "8"], // Stuttgart is a city-county (admin_level 6), its neighbours are 8
    credits: [
      "Map data © OpenStreetMap contributors · Datenquelle: LGL, www.lgl-bw.de, dl-de/by-2-0 (verändert)",
      "Buildings: LGL LoD2 · Terrain: LGL DGM1, Copernicus DEM © DLR, Airbus DS · Trees: LGL nDOM1",
    ],
    // Stuttgart Airport (EDDS) runway 25: threshold and true heading from OSM (way 164016757, node 10710079299),
    // threshold ground 359.9 m NHN from LGL DGM1 (+ geoid 48.4). Planes come in from the east over the faded
    // edge, cross the threshold at 30 m and roll out on the runway (the outline's airport box).
    airport: { lat: 48.6940216, lon: 9.2438069, runwayHeadingDeg: 254, h: 408.3, from: 6000, to: -2500 },
    osmExtract: "https://download.geofabrik.de/europe/germany/baden-wuerttemberg/stuttgart-regbez-latest.osm.pbf",
    geoidM: 48.4, // EGM2008 at Schlossplatz (GeographicLib GeoidEval: 48.373 m)
    groundH: 300, // Kessel floor ~245 m NHN + geoid
    heightBase: 250, // valley ~250 m, Fernsehturm top ~750 m ellipsoid: 150…805 m fits
    sources: "lgl",
    // Stuttgart (OSM relation 62375, Stadtkreis) and the towns around it (admin_level 8): Fellbach, Waiblingen,
    // Remseck am Neckar, Ludwigsburg, Kornwestheim, Korntal-Münchingen, Gerlingen, Ditzingen, Böblingen,
    // Sindelfingen, Leonberg, Esslingen am Neckar, Ostfildern, Filderstadt, Leinfelden-Echterdingen;
    // plus a box over Stuttgart Airport (EDDS) and the Messe, which straddle the borders
    outline: {
      relations: [62375, 401692, 401697, 405291, 405292, 405293, 405811, 405812, 405817, 722090, 722092, 722150, 2792882, 2793022, 2796535, 2796536],
      add: [[48.672, 9.17, 48.712, 9.262]],
    },
  },
  zagreb: {
    title: "Zagreb",
    origin: { lat: 45.81316, lon: 15.97722, h: 0 }, // Trg bana Jelačića
    // NNW: the Lower Town grid runs ~357° (measured on ZG3D footprints), so 330° shows two façades of every
    // block; Gornji grad and Medvednica rise behind the centre, the Sava lies in front
    headingDeg: 330,
    country: "Croatia",
    // the 17 city districts of Grad Zagreb (OSM admin_level 9, names as tagged)
    municipalities: [
      "Gradska četvrt Donji grad", "Gradska četvrt Gornji grad - Medveščak", "Gradska četvrt Trnje",
      "Gradska četvrt Maksimir", "Gradska četvrt Peščenica - Žitnjak", "Gradska četvrt Novi Zagreb - istok",
      "Gradska četvrt Novi Zagreb - zapad", "Gradska četvrt Trešnjevka - sjever", "Gradska četvrt Trešnjevka - jug",
      "Gradska četvrt Črnomerec", "Gradska četvrt Gornja Dubrava", "Gradska četvrt Donja Dubrava",
      "Gradska četvrt Stenjevec", "Gradska četvrt Podsused - Vrapče", "Gradska četvrt Podsljeme",
      "Gradska četvrt Sesvete", "Gradska četvrt Brezovica",
    ],
    adminLevels: ["9"],
    // Zagreb Airport (LDZA) runway 04: south-west threshold and true heading from OSM way 172330757; h = the
    // rendered terrain there (Copernicus, 142.9 m in the region's ENU frame). Planes come in from the south-west
    // over the faded edge, cross the threshold at 30 m, touch down ~570 m on and brake on the 3.25 km runway.
    airport: { lat: 45.7318639, lon: 16.0519638, runwayHeadingDeg: 46.8, h: 152, from: 6000, to: -2300, brake: 2.2 },
    // Jelačić, Zrinjevac, Kaptol (cathedral), Markov trg, Cvjetni trg, Tomislavov trg
    pigeons: [[45.8131, 15.9772], [45.8098, 15.9781], [45.8146, 15.9798], [45.8163, 15.9737], [45.8114, 15.9735], [45.8051, 15.9787]],
    // ZET: 15 day tram lines (1–9, 11–15, 17), most every 6–10 min on weekdays, 1, 8 and 15 less often (here 7.5
    // and 15 min: whole multiples of each other, so trains.ts can time the lines against each other); 31–34 run
    // only at night
    // HŽPP numbers its lines with two digits (80 Savski Marof–Dugo Selo…), its trains with three or more
    rail: {
      stock: "zet", tramInterval: 7.5, interval: { "1": 15, "8": 15, "15": 15 }, night: ["31", "32", "33", "34"],
      mainline: { line: "^\\d{1,2}$", every: 30, single: 240 },
    },
    credits: [
      // Otvorena dozvola: name the source and the date of its last change (data.zagreb.hr: 7 May 2025), mark changes
      "Map data © OpenStreetMap contributors · Buildings: Grad Zagreb, ZG3D 2022, data.zagreb.hr, 7. 5. 2025. (Otvorena dozvola, izmijenjeno)",
      "Terrain: Copernicus DEM © DLR, Airbus DS · Painted with AI",
    ],
    osmExtract: "https://download.geofabrik.de/europe/croatia-latest.osm.pbf",
    boundariesFrom: "extract",
    geoidM: 46.06, // EGM2008 at Trg bana Jelačića (PROJ cs2cs EPSG:4326+3855 -> 4979: 46.057 m)
    groundH: 166, // Lower Town ~120 m a.s.l. + geoid
    heightBase: 200, // Sava ~105 m a.s.l. (151 m ellipsoid) … foothills + towers below ~700 m a.s.l.: 100…755 m fits
    sources: "zg3d",
    // the 17 city districts (OSM admin_level 9, see municipalities) plus a box over Zagreb Airport (Velika Gorica)
    outline: {
      relations: [3173898, 2639024, 2630157, 2365257, 3173936, 3173894, 3173887, 2630379, 2629785, 3174289, 3178488, 3173945, 2631458, 3174275, 3178498, 3173895, 3173886],
      add: [[45.722, 16.040, 45.775, 16.095]], // reaches the city boundary north of the runway
      // Medvednica rises to 1033 m (Sljeme): beyond the height pass's 655 m span above the Sava. South of
      // 45.87° the ground stays below ~605 m, so the map ends there, across the forested slopes.
      clip: [45.5, 15.5, 45.87, 16.5],
    },
  },
};

export const CITIES: Record<string, City> = {
  "tel-aviv-yafo": { title: "Tel Aviv-Yafo", region: "israel-center", center: [32.0745, 34.7810], widthM: 5200 },
  stuttgart: { title: "Stuttgart", region: "stuttgart", center: [48.7784, 9.18], widthM: 3000 },
  zagreb: { title: "Zagreb", region: "zagreb", center: [45.8131, 15.9772], widthM: 3000 },
};

export const DEFAULT_CITY = "tel-aviv-yafo";
