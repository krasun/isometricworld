/**
 * The Wieliczka salt mine as far as open sources tell (MINE-RESEARCH.md, git-excluded, has the full survey):
 * levels, shafts and named chambers, each with its source and how sure it is. Facts (depths, sizes, order of the
 * routes) are not copyrightable; no plan of the mine's own and no tourist map was traced. Horizontal positions of
 * chambers are NOT published anywhere open: they are schematic (`approximate`), placed after the route order and
 * text hints round the shafts (OSM). What no source gives is generated (mine.ts, `illustrative`) and drawn as such.
 *
 * Datum: the papers measure depths from the St. Kinga shaft collar (NMT 242.9 m a.s.l.); the mine's tourist
 * depths are ~6.7 m deeper because they count from the Daniłowicz collar (249.6 m), as the NMT shows.
 */
export type Confidence = "known" | "approximate" | "illustrative";

export interface MineLevel {
  /** short id, as the mine numbers its levels */
  id: string;
  name: string;
  /** depth below the St. Kinga shaft collar (m) */
  depth: number;
  /** depth the mine gives visitors (from the Daniłowicz collar), where it gives one */
  tourist?: number;
  /** chambers on the level (2017 table; III with the Kazanów inter-level, V with Kołobrzeg) */
  chambers: number;
  /** the part of the mine's outline (OSM) along its long axis the level's workings span, 0 west … 1 east */
  span: [number, number];
  note: string;
  /** the note as the map shows it (Polish) */
  pl: string;
}

export interface MineShaft {
  /** name as in OSM (man_made=mineshaft) */
  name: string;
  /** deepest level reached */
  to: string;
  depth?: number;
  conf: Confidence;
  note: string;
}

export interface MineChamber {
  name: string;
  level: string;
  kind: "chamber" | "chapel" | "lake" | "hall" | "museum" | "grotto";
  /** floor size (m): along, across; and height where published */
  size: [number, number];
  height?: number;
  /** depth as published (m, the mine's tourist datum unless said otherwise) */
  depth?: number;
  /** schematic position: metres east and north of a shaft (OSM) */
  at: { shaft: string; e: number; n: number; turn?: number };
  route?: "tourist" | "miners" | "museum";
  conf: Confidence;
  src: string;
}

export const SOURCES: Record<string, { title: string; url: string; licence: string }> = {
  decree: { title: "Zarządzenie Prezydenta RP z 8 IX 1994 (M.P. 1994 nr 50 poz. 424): extent, levels, totals", url: "https://eli.gov.pl/eli/MP/1994/424/ogl/pol/pdf", licence: "official act, not protected (Polish Copyright Act art. 4)" },
  dobyrn: { title: "d'Obyrn & Hydzik-Wiśniewska 2017, Arch. Min. Sci. 62(1), Table 1: level depths and chamber counts", url: "https://doi.org/10.1515/amsc-2017-0014", licence: "facts only" },
  wiewiorka: { title: "Wiewiórka et al. 2009, Geoturystyka 4(18): level names and depths, shaft order", url: "https://doi.org/10.7494/geotour.2009.18.61", licence: "CC BY 4.0 (facts only used)" },
  minersRoute: { title: "Trasa Górnicza, Geologia/Geology, Geophysics & Environment 38(2) 2012: order of the Miners' Route", url: "https://doi.org/10.7494/geol.2012.38.2.283", licence: "CC BY 4.0 (facts only used)" },
  mine: { title: "Kopalnia Soli „Wieliczka”, kopalnia.pl: route and chamber depths and sizes", url: "https://www.kopalnia.pl/", licence: "facts only" },
  plwiki: { title: "Polish Wikipedia, Kopalnia soli w Wieliczce: chambers of the Tourist Route, in order", url: "https://pl.wikipedia.org/wiki/Kopalnia_soli_w_Wieliczce", licence: "facts only" },
  hondius: { title: "Willem Hondius 1645 after Marcin German 1638, level I plan (Commons)", url: "https://commons.wikimedia.org/wiki/File:Wieliczka_Salt_Mines_2.jpg", licence: "public domain" },
  osm: { title: "OpenStreetMap: shafts, the mine's outline, the Groty Kryształowe reserve (GDOŚ)", url: "https://www.openstreetmap.org/", licence: "ODbL" },
};

/** St. Kinga shaft collar, NMT (EVRF2007), the depths' zero */
export const COLLAR = 242.9;

export const LEVELS: MineLevel[] = [
  { id: "I", name: "Bono", depth: 57.4, tourist: 64, chambers: 126, span: [0, 1], note: "the start of the Tourist Route (Daniłowicz shaft stairs) and of the Miners' Route (Regis)", pl: "tu zaczyna się Trasa Turystyczna (schody szybu Daniłowicza) i Trasa Górnicza (szyb Regis)" },
  { id: "IIw", name: "Braci Markowskich", depth: 84.3, tourist: 90, chambers: 46, span: [0.05, 0.95], note: "level II, upper", pl: "poziom II wyższy" },
  { id: "IIn", name: "Mickiewicz", depth: 103.5, tourist: 110, chambers: 246, span: [0, 1], note: "level II, lower: St. Kinga's Chapel, Michałowice, Drozdowice", pl: "poziom II niższy: kaplica św. Kingi, komory Michałowice i Drozdowice" },
  { id: "III", name: "Słowacki", depth: 129.4, tourist: 135, chambers: 378, span: [0, 1], note: "with the Kazanów inter-level: Warszawa, the museum, the health resort, the lift up", pl: "z międzypoziomem Kazanów: komora Warszawa, muzeum, uzdrowisko, winda na powierzchnię" },
  { id: "IV", name: "Grunwald", depth: 170.3, chambers: 512, span: [0, 0.95], note: "kept as a stable support; not open to visitors", pl: "pozostawiony jako stabilna podpora, niedostępny dla zwiedzających" },
  { id: "V", name: "Austria", depth: 198.8, chambers: 447, span: [0.1, 0.95], note: "with the Kołobrzeg inter-level; kept as a stable support", pl: "z międzypoziomem Kołobrzeg; pozostawiony jako stabilna podpora" },
  { id: "VI", name: "Regis", depth: 236.5, chambers: 233, span: [0.27, 1], note: "being backfilled; nothing west of the Kościuszko shaft", pl: "podsadzany; nic na zachód od szybu Kościuszko" },
  { id: "VII", name: "Warszawa", depth: 255.2, chambers: 121, span: [0.27, 0.92], note: "being backfilled; nothing west of the Kościuszko shaft", pl: "podsadzany; nic na zachód od szybu Kościuszko" },
  { id: "VIII", name: "Biliński", depth: 287.6, chambers: 66, span: [0.2, 0.75], note: "being backfilled", pl: "podsadzany" },
  { id: "IX", name: "", depth: 327.2, chambers: 2, span: [0.33, 0.45], note: "the deepest: two chambers, by the St. Kinga shaft", pl: "najgłębszy: dwie komory przy szybie św. Kingi" },
];

export const SHAFTS: MineShaft[] = [
  { name: "Szyb Kościuszko", to: "VIII", depth: 297.5, conf: "known", note: "1790; links levels I–VIII; ventilation, drainage, backfill" },
  { name: "Szyb św. Kingi", to: "IX", conf: "approximate", note: "1864; the depths' zero; reaches at least level VIII" },
  { name: "Szyb Daniłowicza", to: "III", depth: 135, conf: "known", note: "1635; the Tourist Route: stairs down to level I, the lift up from level III" },
  { name: "Szyb Górsko", to: "IV", depth: 177, conf: "approximate", note: "1620, closed 1954; depth from OSM" },
  { name: "Szyb Regis", to: "III", depth: 127, conf: "known", note: "14th century; the Miners' Route lifts" },
  { name: "Szyb Paderewskiego", to: "I", conf: "approximate", note: "1812; being rebuilt for visitors, lined down to level I so far" },
  { name: "Szyb Wilson", to: "III", conf: "illustrative", note: "1913, a ventilation shaft; its depth is not published" },
];

/** Height of the cutaway: walls rise this far over a level's floor, where the rock is cut (renderer page/mine.ts). */
export const CAP = 3;

const D = "Szyb Daniłowicza", R = "Szyb Regis";
/** The routes' chambers in their published order; positions schematic round the shaft each route starts from. */
export const CHAMBERS: MineChamber[] = [
  // Tourist Route, level I (64 m): down the Daniłowicz stairs
  { name: "Komora Mikołaja Kopernika", level: "I", kind: "chamber", size: [22, 14], at: { shaft: D, e: 40, n: -25 }, route: "tourist", conf: "approximate", src: "plwiki" },
  { name: "Kaplica św. Antoniego", level: "I", kind: "chapel", size: [7.5, 6], height: 5.5, at: { shaft: D, e: 78, n: -5 }, route: "tourist", conf: "approximate", src: "plwiki" },
  // Janowice and Sielec beside the Daniłowicz shaft, as Hondius's 1645 plan has them
  { name: "Komora Janowice", level: "I", kind: "chamber", size: [30, 18], at: { shaft: D, e: 34, n: 22 }, route: "tourist", conf: "approximate", src: "hondius" },
  { name: "Komora Sielec", level: "I", kind: "chamber", size: [26, 15], at: { shaft: D, e: -39, n: 60, turn: 30 }, route: "tourist", conf: "approximate", src: "hondius" },
  { name: "Komora Kazimierza Wielkiego", level: "I", kind: "chamber", size: [24, 16], at: { shaft: D, e: 95, n: 45 }, route: "tourist", conf: "approximate", src: "plwiki" },
  { name: "Komora Pieskowa Skała", level: "I", kind: "chamber", size: [20, 12], at: { shaft: D, e: 175, n: 5, turn: -20 }, route: "tourist", conf: "approximate", src: "plwiki" },
  // level II upper (90 m)
  { name: "Kaplica Krzyża Świętego", level: "IIw", kind: "chapel", size: [12, 8], at: { shaft: D, e: 235, n: -75 }, route: "tourist", conf: "approximate", src: "plwiki" },
  { name: "Komora Weimar", level: "IIw", kind: "lake", size: [34, 16], at: { shaft: D, e: 300, n: -25, turn: 15 }, route: "tourist", conf: "approximate", src: "plwiki" },
  // level II lower (110 m)
  { name: "Kaplica św. Kingi", level: "IIn", kind: "chapel", size: [54, 18], height: 12, depth: 101, at: { shaft: D, e: 330, n: -110 }, route: "tourist", conf: "approximate", src: "mine" },
  { name: "Komora Erazma Barącza", level: "IIn", kind: "lake", size: [30, 18], at: { shaft: D, e: 400, n: -55, turn: -10 }, route: "tourist", conf: "approximate", src: "plwiki" },
  { name: "Komora Michałowice", level: "IIn", kind: "hall", size: [34, 22], height: 36, depth: 110, at: { shaft: D, e: 440, n: -150 }, route: "tourist", conf: "approximate", src: "mine" },
  { name: "Komora Drozdowice", level: "IIn", kind: "chamber", size: [22, 15], depth: 110, at: { shaft: D, e: 500, n: -95 }, route: "tourist", conf: "approximate", src: "mine" },
  { name: "Komora Józefa Piłsudskiego", level: "IIn", kind: "lake", size: [32, 14], at: { shaft: D, e: 545, n: -175, turn: 20 }, route: "tourist", conf: "approximate", src: "plwiki" },
  // level III with Kazanów (125–135 m): back west to the Daniłowicz lift
  { name: "Komora Stanisława Staszica", level: "III", kind: "hall", size: [30, 20], height: 36, at: { shaft: D, e: 520, n: -255 }, route: "tourist", conf: "approximate", src: "mine" },
  { name: "Komora Witolda Budryka", level: "III", kind: "chamber", size: [20, 12], at: { shaft: D, e: 445, n: -285 }, route: "tourist", conf: "approximate", src: "plwiki" },
  { name: "Komora Warszawa", level: "III", kind: "hall", size: [54, 17], height: 9, depth: 125, at: { shaft: D, e: 350, n: -250, turn: -10 }, route: "tourist", conf: "approximate", src: "mine" },
  { name: "Karczma Górnicza", level: "III", kind: "hall", size: [24, 14], depth: 125, at: { shaft: D, e: 290, n: -200 }, route: "tourist", conf: "approximate", src: "mine" },
  { name: "Komora Wisła", level: "III", kind: "chamber", size: [22, 12], at: { shaft: D, e: 230, n: -230 }, route: "tourist", conf: "approximate", src: "plwiki" },
  { name: "Kaplica św. Jana", level: "III", kind: "chapel", size: [14, 11], depth: 135, at: { shaft: D, e: 165, n: -160 }, route: "tourist", conf: "approximate", src: "mine" },
  { name: "Jezioro Wessel", level: "III", kind: "lake", size: [40, 18], depth: 135, at: { shaft: D, e: 100, n: -115, turn: 25 }, route: "tourist", conf: "approximate", src: "plwiki" },
  { name: "Komora Gwarków", level: "III", kind: "hall", size: [14, 8], depth: 135, at: { shaft: D, e: 35, n: -45 }, route: "tourist", conf: "approximate", src: "mine" },
  // the museum (level III, 1.5 km, towards Regis)
  { name: "Komora Saurau", level: "III", kind: "museum", size: [36, 20], at: { shaft: D, e: 240, n: 40 }, route: "museum", conf: "approximate", src: "plwiki" },
  { name: "Komora Kraj", level: "III", kind: "museum", size: [20, 16], at: { shaft: D, e: 320, n: 70 }, route: "museum", conf: "approximate", src: "plwiki" },
  { name: "Komora Maria Teresa", level: "III", kind: "museum", size: [26, 14], at: { shaft: D, e: 400, n: 40 }, route: "museum", conf: "approximate", src: "plwiki" },
  { name: "Komora Russegger", level: "III", kind: "museum", size: [24, 12], at: { shaft: D, e: 470, n: 85 }, route: "museum", conf: "approximate", src: "plwiki" },
  // Miners' Route round the Regis shaft: level I (57 m), then down to level II
  { name: "Komora Boczaniec", level: "I", kind: "chamber", size: [22, 14], at: { shaft: R, e: 35, n: -40 }, route: "miners", conf: "approximate", src: "minersRoute" },
  { name: "Komora Fortymbark", level: "I", kind: "chamber", size: [18, 12], at: { shaft: R, e: 95, n: -20 }, route: "miners", conf: "approximate", src: "minersRoute" },
  { name: "Komora Janik", level: "I", kind: "chamber", size: [16, 12], at: { shaft: R, e: 120, n: 40 }, route: "miners", conf: "approximate", src: "minersRoute" },
  { name: "Komora Gospoda", level: "I", kind: "chamber", size: [18, 11], at: { shaft: R, e: 60, n: 85 }, route: "miners", conf: "approximate", src: "minersRoute" },
  { name: "Komora Lipowiec", level: "I", kind: "chamber", size: [20, 13], at: { shaft: R, e: -15, n: 100 }, route: "miners", conf: "approximate", src: "minersRoute" },
  { name: "Komora Korytno", level: "I", kind: "chamber", size: [18, 12], at: { shaft: R, e: -75, n: 50 }, route: "miners", conf: "approximate", src: "minersRoute" },
  { name: "Komora Tanecznica", level: "I", kind: "chamber", size: [20, 12], at: { shaft: R, e: -110, n: -15 }, route: "miners", conf: "approximate", src: "minersRoute" },
  { name: "Komora Rzepki", level: "I", kind: "chamber", size: [16, 12], at: { shaft: R, e: -70, n: -75 }, route: "miners", conf: "approximate", src: "minersRoute" },
  { name: "Komora Franciszka Karola", level: "IIn", kind: "chamber", size: [24, 14], at: { shaft: R, e: 25, n: -65 }, route: "miners", conf: "approximate", src: "minersRoute" },
  // elsewhere
  { name: "Komora Kloski", level: "V", kind: "hall", size: [30, 18], depth: 197, at: { shaft: D, e: 120, n: -60 }, conf: "approximate", src: "dobyrn" },
];

/** OSM name of the Groty Kryształowe reserve (its outline is known: GDOŚ via OSM), ~80 m below the town */
export const GROTTO = { name: "Rezerwat Groty Kryształowe", level: "IIw" };
