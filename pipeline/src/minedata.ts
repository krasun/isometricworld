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
  /** what the map's level panel says about it */
  note: string;
}

export interface MineShaft {
  /** name as in OSM (man_made=mineshaft) */
  name: string;
  /** name on the map (English, as the mine's own English pages name it) */
  en: string;
  /** deepest level reached */
  to: string;
  depth?: number;
  conf: Confidence;
  note: string;
}

export interface MineChamber {
  name: string;
  /** name on the map (English) */
  en: string;
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
  decree: { title: "Decree of the President of Poland of 8 September 1994 (M.P. 1994 nr 50 poz. 424): extent, levels, totals", url: "https://eli.gov.pl/eli/MP/1994/424/ogl/pol/pdf", licence: "official act, not protected (Polish Copyright Act art. 4)" },
  dobyrn: { title: "d'Obyrn & Hydzik-Wiśniewska 2017, Arch. Min. Sci. 62(1), Table 1: level depths and chamber counts", url: "https://doi.org/10.1515/amsc-2017-0014", licence: "facts only" },
  wiewiorka: { title: "Wiewiórka et al. 2009, Geoturystyka 4(18): level names and depths, shaft order", url: "https://doi.org/10.7494/geotour.2009.18.61", licence: "CC BY 4.0 (facts only used)" },
  minersRoute: { title: "„Trasa Górnicza”, Geology, Geophysics & Environment 38(2) 2012: order of the Miners' Route", url: "https://doi.org/10.7494/geol.2012.38.2.283", licence: "CC BY 4.0 (facts only used)" },
  mine: { title: "Wieliczka Salt Mine, kopalnia.pl: route and chamber depths and sizes", url: "https://www.kopalnia.pl/", licence: "facts only" },
  plwiki: { title: "Polish Wikipedia, „Kopalnia soli w Wieliczce”: chambers of the Tourist Route, in order", url: "https://pl.wikipedia.org/wiki/Kopalnia_soli_w_Wieliczce", licence: "facts only" },
  hondius: { title: "Willem Hondius 1645 after Marcin German 1638, level I plan (Commons)", url: "https://commons.wikimedia.org/wiki/File:Wieliczka_Salt_Mines_2.jpg", licence: "public domain" },
  geology: { title: "Alexandrowicz 1994, Chrońmy Przyrodę Ojczystą 50(4): the deposit's build, block salt over folded layered salt (the rock's drawing)", url: "https://rcin.org.pl/Content/69150/PDF/KR038_87857_r1994-t50-no4_ChPO-Alexandrowicz_s31-46.pdf", licence: "facts only" },
  kloski: { title: "Przybyło & Włodarczyk-Żurek 2018, Przegląd Solny 14: the Kloski–Colloredo water inflows of 1868–1879 (level V)", url: "https://yadda.icm.edu.pl/baztech/element/bwmeta1.element.baztech-a0929c9c-607a-41ca-84f1-7205d363d4cc/c/Przybylo_Katastrofa_14_2018.pdf", licence: "facts only" },
  mina: { title: "Żarębski 2017, Nowoczesne Budownictwo Inżynieryjne 3/2017: the Mina cross-cut inflow of 13 April 1992 (level IV)", url: "https://nbi.com.pl/content/uploads/assets/NBI-pdf/2017/3_72_2017/Pdf/7_Zbigniew_Zarebski.pdf", licence: "facts only" },
  minaSealed: { title: "Duliński 2017, Przegląd Solny 13: the Mina leak (WIV-27) studied until it was sealed in October 2007", url: "https://yadda.icm.edu.pl/baztech/element/bwmeta1.element.baztech-cba34da1-a860-49b0-8241-3fcea6b515c5/c/Dulinski_Badania_izotopwe_13_2017.pdf", licence: "facts only" },
  osm: { title: "OpenStreetMap: shafts, the mine's outline, the Crystal Grottoes reserve (GDOŚ)", url: "https://www.openstreetmap.org/", licence: "ODbL" },
};

/** St. Kinga shaft collar, NMT (EVRF2007), the depths' zero */
export const COLLAR = 242.9;

export const LEVELS: MineLevel[] = [
  { id: "I", name: "Bono", depth: 57.4, tourist: 64, chambers: 126, span: [0, 1], note: "the Tourist Route starts here (the Daniłowicz shaft stairs), and so does the Miners' Route (the Regis shaft)" },
  { id: "IIw", name: "Markowski Brothers", depth: 84.3, tourist: 90, chambers: 46, span: [0.05, 0.95], note: "about 80 m below the town lies the Crystal Grottoes nature reserve (its outline from GDOŚ via OSM, the grotto itself approximate)" },
  { id: "IIn", name: "Mickiewicz", depth: 103.5, tourist: 110, chambers: 246, span: [0, 1], note: "St. Kinga's Chapel and the Michałowice and Drozdowice chambers" },
  { id: "III", name: "Słowacki", depth: 129.4, tourist: 135, chambers: 378, span: [0, 1], note: "with the Kazanów inter-level: the Warszawa Chamber, the museum, the health resort and the lift back up" },
  { id: "IV", name: "Grunwald", depth: 170.3, chambers: 512, span: [0, 0.95], note: "left as a stable support, closed to visitors. In 1992 water and sand broke in at the Mina cross-cut on its northern edge and the ground above sank; the leak was sealed in 2007" },
  { id: "V", name: "Austria", depth: 198.8, chambers: 447, span: [0.1, 0.95], note: "with the Kołobrzeg inter-level; left as a stable support. In 1868 water broke in at its Kloski cross-cut, flooding the workings below; it kept coming until 1879" },
  { id: "VI", name: "Regis", depth: 236.5, chambers: 233, span: [0.27, 1], note: "being backfilled; nothing west of the Kościuszko shaft" },
  { id: "VII", name: "Warszawa", depth: 255.2, chambers: 121, span: [0.27, 0.92], note: "being backfilled; nothing west of the Kościuszko shaft" },
  { id: "VIII", name: "Biliński", depth: 287.6, chambers: 66, span: [0.2, 0.75], note: "being backfilled" },
  { id: "IX", name: "", depth: 327.2, chambers: 2, span: [0.33, 0.45], note: "the deepest: two chambers by the St. Kinga shaft" },
];

export const SHAFTS: MineShaft[] = [
  { name: "Szyb Kościuszko", en: "Kościuszko Shaft", to: "VIII", depth: 297.5, conf: "known", note: "1790; links levels I–VIII; ventilation, drainage, backfill" },
  { name: "Szyb św. Kingi", en: "St. Kinga Shaft", to: "IX", conf: "approximate", note: "1864; the depths' zero; reaches at least level VIII" },
  { name: "Szyb Daniłowicza", en: "Daniłowicz Shaft", to: "III", depth: 135, conf: "known", note: "1635; the Tourist Route: stairs down to level I, the lift up from level III" },
  { name: "Szyb Górsko", en: "Górsko Shaft", to: "IV", depth: 177, conf: "approximate", note: "1620, closed 1954; depth from OSM" },
  { name: "Szyb Regis", en: "Regis Shaft", to: "III", depth: 127, conf: "known", note: "14th century; the Miners' Route lifts" },
  { name: "Szyb Paderewskiego", en: "Paderewski Shaft", to: "I", conf: "approximate", note: "1812; being rebuilt for visitors, lined down to level I so far" },
  { name: "Szyb Wilson", en: "Wilson Shaft", to: "III", conf: "illustrative", note: "1913, a ventilation shaft; its depth is not published" },
];

/** Height of the cutaway: walls rise this far over a level's floor, where the rock is cut (renderer page/mine.ts). */
export const CAP = 3;

const D = "Szyb Daniłowicza", R = "Szyb Regis";
/** The routes' chambers in their published order; positions schematic round the shaft each route starts from. */
export const CHAMBERS: MineChamber[] = [
  // Tourist Route, level I (64 m): down the Daniłowicz stairs
  { name: "Komora Mikołaja Kopernika", en: "Nicolaus Copernicus Chamber", level: "I", kind: "chamber", size: [22, 14], at: { shaft: D, e: 40, n: -25 }, route: "tourist", conf: "approximate", src: "plwiki" },
  { name: "Kaplica św. Antoniego", en: "St. Anthony's Chapel", level: "I", kind: "chapel", size: [7.5, 6], height: 5.5, at: { shaft: D, e: 78, n: -5 }, route: "tourist", conf: "approximate", src: "plwiki" },
  // Janowice and Sielec where Hondius's 1645 plan puts them (georeferenced on three shafts: mine.ts, HONDIUS)
  { name: "Komora Janowice", en: "Janowice Chamber", level: "I", kind: "chamber", size: [30, 18], at: { shaft: D, e: 34, n: 22 }, route: "tourist", conf: "approximate", src: "hondius" },
  { name: "Komora Sielec", en: "Sielec Chamber", level: "I", kind: "chamber", size: [26, 15], at: { shaft: D, e: -39, n: 60, turn: 30 }, route: "tourist", conf: "approximate", src: "hondius" },
  { name: "Komora Kazimierza Wielkiego", en: "Casimir the Great Chamber", level: "I", kind: "chamber", size: [24, 16], at: { shaft: D, e: 95, n: 45 }, route: "tourist", conf: "approximate", src: "plwiki" },
  { name: "Komora Pieskowa Skała", en: "Pieskowa Skała Chamber", level: "I", kind: "chamber", size: [20, 12], at: { shaft: D, e: 175, n: 5, turn: -20 }, route: "tourist", conf: "approximate", src: "plwiki" },
  // level II upper (90 m)
  { name: "Kaplica Krzyża Świętego", en: "Holy Cross Chapel", level: "IIw", kind: "chapel", size: [12, 8], at: { shaft: D, e: 235, n: -75 }, route: "tourist", conf: "approximate", src: "plwiki" },
  { name: "Komora Weimar", en: "Weimar Chamber", level: "IIw", kind: "lake", size: [34, 16], at: { shaft: D, e: 300, n: -25, turn: 15 }, route: "tourist", conf: "approximate", src: "plwiki" },
  // level II lower (110 m)
  { name: "Kaplica św. Kingi", en: "St. Kinga's Chapel", level: "IIn", kind: "chapel", size: [54, 18], height: 12, depth: 101, at: { shaft: D, e: 330, n: -110 }, route: "tourist", conf: "approximate", src: "mine" },
  { name: "Komora Erazma Barącza", en: "Erazm Barącz Chamber", level: "IIn", kind: "lake", size: [30, 18], at: { shaft: D, e: 400, n: -55, turn: -10 }, route: "tourist", conf: "approximate", src: "plwiki" },
  { name: "Komora Michałowice", en: "Michałowice Chamber", level: "IIn", kind: "hall", size: [34, 22], height: 36, depth: 110, at: { shaft: D, e: 440, n: -150 }, route: "tourist", conf: "approximate", src: "mine" },
  { name: "Komora Drozdowice", en: "Drozdowice Chamber", level: "IIn", kind: "chamber", size: [22, 15], depth: 110, at: { shaft: D, e: 500, n: -95 }, route: "tourist", conf: "approximate", src: "mine" },
  { name: "Komora Józefa Piłsudskiego", en: "Józef Piłsudski Chamber", level: "IIn", kind: "lake", size: [32, 14], at: { shaft: D, e: 545, n: -175, turn: 20 }, route: "tourist", conf: "approximate", src: "plwiki" },
  // level III with Kazanów (125–135 m): back west to the Daniłowicz lift
  { name: "Komora Stanisława Staszica", en: "Stanisław Staszic Chamber", level: "III", kind: "hall", size: [30, 20], height: 36, at: { shaft: D, e: 520, n: -255 }, route: "tourist", conf: "approximate", src: "mine" },
  { name: "Komora Witolda Budryka", en: "Witold Budryk Chamber", level: "III", kind: "chamber", size: [20, 12], at: { shaft: D, e: 445, n: -285 }, route: "tourist", conf: "approximate", src: "plwiki" },
  { name: "Komora Warszawa", en: "Warszawa Chamber", level: "III", kind: "hall", size: [54, 17], height: 9, depth: 125, at: { shaft: D, e: 350, n: -250, turn: -10 }, route: "tourist", conf: "approximate", src: "mine" },
  { name: "Karczma Górnicza", en: "Miners' Tavern", level: "III", kind: "hall", size: [24, 14], depth: 125, at: { shaft: D, e: 290, n: -200 }, route: "tourist", conf: "approximate", src: "mine" },
  { name: "Komora Wisła", en: "Wisła Chamber", level: "III", kind: "chamber", size: [22, 12], at: { shaft: D, e: 230, n: -230 }, route: "tourist", conf: "approximate", src: "plwiki" },
  { name: "Kaplica św. Jana", en: "St. John's Chapel", level: "III", kind: "chapel", size: [14, 11], depth: 135, at: { shaft: D, e: 165, n: -160 }, route: "tourist", conf: "approximate", src: "mine" },
  { name: "Jezioro Wessel", en: "Wessel Lake", level: "III", kind: "lake", size: [40, 18], depth: 135, at: { shaft: D, e: 100, n: -115, turn: 25 }, route: "tourist", conf: "approximate", src: "plwiki" },
  { name: "Komora Gwarków", en: "Gwarków Chamber", level: "III", kind: "hall", size: [14, 8], depth: 135, at: { shaft: D, e: 35, n: -45 }, route: "tourist", conf: "approximate", src: "mine" },
  // the museum (level III, 1.5 km, towards Regis)
  { name: "Komora Saurau", en: "Saurau Chamber", level: "III", kind: "museum", size: [36, 20], at: { shaft: D, e: 240, n: 40 }, route: "museum", conf: "approximate", src: "plwiki" },
  { name: "Komora Kraj", en: "Kraj Chamber", level: "III", kind: "museum", size: [20, 16], at: { shaft: D, e: 320, n: 70 }, route: "museum", conf: "approximate", src: "plwiki" },
  { name: "Komora Maria Teresa", en: "Maria Teresa Chamber", level: "III", kind: "museum", size: [26, 14], at: { shaft: D, e: 400, n: 40 }, route: "museum", conf: "approximate", src: "plwiki" },
  { name: "Komora Russegger", en: "Russegger Chamber", level: "III", kind: "museum", size: [24, 12], at: { shaft: D, e: 470, n: 85 }, route: "museum", conf: "approximate", src: "plwiki" },
  // Miners' Route round the Regis shaft: level I (57 m), then down to level II
  { name: "Komora Boczaniec", en: "Boczaniec Chamber", level: "I", kind: "chamber", size: [22, 14], at: { shaft: R, e: 35, n: -40 }, route: "miners", conf: "approximate", src: "minersRoute" },
  { name: "Komora Fortymbark", en: "Fortymbark Chamber", level: "I", kind: "chamber", size: [18, 12], at: { shaft: R, e: 95, n: -20 }, route: "miners", conf: "approximate", src: "minersRoute" },
  { name: "Komora Janik", en: "Janik Chamber", level: "I", kind: "chamber", size: [16, 12], at: { shaft: R, e: 120, n: 40 }, route: "miners", conf: "approximate", src: "minersRoute" },
  { name: "Komora Gospoda", en: "Gospoda Chamber", level: "I", kind: "chamber", size: [18, 11], at: { shaft: R, e: 60, n: 85 }, route: "miners", conf: "approximate", src: "minersRoute" },
  { name: "Komora Lipowiec", en: "Lipowiec Chamber", level: "I", kind: "chamber", size: [20, 13], at: { shaft: R, e: -15, n: 100 }, route: "miners", conf: "approximate", src: "minersRoute" },
  { name: "Komora Korytno", en: "Korytno Chamber", level: "I", kind: "chamber", size: [18, 12], at: { shaft: R, e: -75, n: 50 }, route: "miners", conf: "approximate", src: "minersRoute" },
  { name: "Komora Tanecznica", en: "Tanecznica Chamber", level: "I", kind: "chamber", size: [20, 12], at: { shaft: R, e: -110, n: -15 }, route: "miners", conf: "approximate", src: "minersRoute" },
  { name: "Komora Rzepki", en: "Rzepki Chamber", level: "I", kind: "chamber", size: [16, 12], at: { shaft: R, e: -70, n: -75 }, route: "miners", conf: "approximate", src: "minersRoute" },
  { name: "Komora Franciszka Karola", en: "Franciszek Karol Chamber", level: "IIn", kind: "chamber", size: [24, 14], at: { shaft: R, e: 25, n: -65 }, route: "miners", conf: "approximate", src: "minersRoute" },
  // elsewhere
  { name: "Komora Kloski", en: "Kloski Chamber", level: "V", kind: "hall", size: [30, 18], depth: 197, at: { shaft: D, e: 120, n: -60 }, conf: "approximate", src: "dobyrn" },
];

/**
 * Hondius's 1645 plan of the first level (after Marcin German's 1638 survey; Commons, public domain), in image
 * pixels of data/raw/mine/hondius/<file>: the three shafts it shares with today (control points for the fit in
 * mine.ts: 2–4 m residuals, 0.156 m per pixel, turned 173°: north is down), the plan without its register,
 * title and views, and what it names that is gone or renamed, keyed by their names on the map (placed through the fit).
 */
export const HONDIUS = {
  file: "Wieliczka_Salt_Mines_2.jpg",
  url: "https://commons.wikimedia.org/wiki/Special:FilePath/Wieliczka_Salt_Mines_2.jpg",
  crop: [3150, 3560, 11600, 7700],
  control: { "Szyb Górsko": [9697, 4632], "Szyb Daniłowicza": [10902, 5579], "Szyb Regis": [8482, 6471] } as Record<string, [number, number]>,
  gone: { "Lubomierz Shaft": [3314, 3924], "Boner Shaft": [5577, 5156], "Buzenin Shaft": [4121, 5762], "Lays Shaft": [5573, 6391], "Seraf Shaft": [7911, 5304], "Wodny Shaft": [8788, 6647] } as Record<string, [number, number]>,
  chambers: { "Janowice Chamber": [10691, 5728], "Sielec Chamber": [11189, 5914], "Kazanów Chamber": [10530, 4860], "Witów Chamber": [11067, 5361] } as Record<string, [number, number]>,
};

/** OSM name of the Groty Kryształowe reserve (its outline is known: GDOŚ via OSM), ~80 m below the town */
export const GROTTO = { name: "Rezerwat Groty Kryształowe", en: "Crystal Grottoes", level: "IIw" };

/**
 * The rock between the workings, for the drawing only (page/mine.ts; illustrative, not mapped). The deposit has two
 * parts (Alexandrowicz 1994, SOURCES.geology): the block deposit, green salt boulders in clay and zuber, lies over the
 * layered deposit, folded beds of spiza, shaft and green salt with anhydrite and clay between them. The deeper the
 * level, the more of it is drawn layered: this is the share of its width across the strike, counted from the south.
 * The shares are a guess for the picture, not a reading of the mine's sections.
 */
export const LAYERED: Record<string, number> = { I: 0.15, IIw: 0.25, IIn: 0.35, III: 0.5, IV: 0.65, V: 0.75, VI: 0.85, VII: 0.9, VIII: 0.95, IX: 1 };

export interface MineEgg {
  level: string;
  kind: "dino" | "ring" | "chest" | "tools" | "gnome";
  name: string;
  note: string;
  /** a chamber or shaft (its Polish key) to put it near; else the middle of the level */
  near?: string;
  /** across (m) */
  size: number;
}

/** Things that are just for fun, hidden in the rock: drawn and labelled as such (✦ on the map). */
export const EGGS: MineEgg[] = [
  { level: "I", kind: "tools", name: "A lost lamp and pick", note: "just for fun: someone will be looking for these", near: "Szyb Regis", size: 9 },
  { level: "IIn", kind: "ring", name: "St. Kinga's ring", note: "just for fun: in the legend it turned up in the first lump of salt dug in Poland", near: "Kaplica św. Kingi", size: 8 },
  { level: "IV", kind: "gnome", name: "A salt gnome", note: "just for fun: he keeps an eye on the support pillars", near: "Szyb Kościuszko", size: 10 },
  { level: "V", kind: "chest", name: "The Skarbnik's treasure", note: "just for fun: the mine spirit of Polish miners' tales guards it", near: "Komora Kloski", size: 10 },
  // the salt is Badenian, about 13.6 million years old; the last dinosaurs died 66 million years ago
  { level: "IX", kind: "dino", name: "A dinosaur", note: "just for fun: it could never be here, the salt is 52 million years younger than the last dinosaurs", size: 60 },
];
