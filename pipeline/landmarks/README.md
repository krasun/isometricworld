# Landmark prompts

Per landmark, the text `src/landmark.ts` sends to Codex (the image list and output line are added by the tool):
`overview.txt` (the one coherent painting) and `key.txt` (what stays when everything else turns magenta). Edits that were
pasted back by box are listed per landmark below, so a landmark can be recreated.

- `wasen` (stuttgart-core, Cannstatter Volksfest): frame 3630,6880,3600,2400, `--base render --style reference-simple.png`,
  refs (PD/CC0, see ATTRIBUTION.md) `Volksfest_2010_Blick_aus_dem_Riesenrad.jpg`, `Cannstatter_Wasen_30092013_4.jpg`.
  Then a tower edit (box 1140,254,1245,405) and a Fruchtsäule edit (355,480,450,635); windows 4..7 × 8..9 painted with
  `paint.ts --guide`. Made before this tool: its files are in overview-wasen-v4/ and overview-wasen-key/.
- `arena` (stuttgart-east, MHPArena): frame 1760,10200,1536,1024, `--base paint --aerial`. Files in overview-arena/ and
  overview-arena-key/ (made before this tool).
- `neues-schloss`, `kunstgebaeude`, `landtag`, `staatstheater` (stuttgart-core, Schlossgarten): one native frame each
  (-990,-1100 / -420,-1100 / -904,-622 / -325,-258, all 1536×1024), `--base render --aerial --aerial-source city
  --style reference-simple.png`, refs from `data/raw/photos/neues-schloss/`, `kunstgebaeude/`, `landtag/`, `oper/` +
  `schauspielhaus/` (PD/CC0/CC BY, see ATTRIBUTION.md). No edits. The Landtag key was run twice (the first came back
  tinted instead of flat magenta: check that the mask is a few % of the frame).
- `stadtbibliothek`, `milaneo` (stuttgart-core, Europaviertel): one native frame each (4127,38 / 4596,145, both 1536×1024),
  `--base render --aerial --aerial-source city --style reference-simple.png`, refs from `data/raw/photos/stadtbibliothek/`
  and `milaneo/` (CC0/CC BY, see ATTRIBUTION.md), in the order listed in their SOURCES.md. No edits. The Milaneo's roofs
  (green roof gardens, oval skylights) come from the orthophoto: no open photo shows them. Masks 3 % and 25 % of the frame.
- `feuersee` (stuttgart-core, Johanneskirche and the whole Feuersee lot): native frame -2058,-4812,1536,1024 (`--frame=`
  with `=`: negative values), `--base render --style reference-simple.png`, refs from `data/raw/photos/johanneskirche/`
  in the order of its SOURCES.md, no aerial. The first try (four ground photos, aerial, "real olive water") painted the
  church side-on and lost the pond's shape: LoD2 has no tower, so the model invented one from the photos. Fixed in the
  model first (`landmarks.ts` `johanneskirche`: a 45 m tower from OSM's bell_tower part, `REBUILDS` by wikidata, which
  the LGL fetch now includes), then two refs and a prompt that keeps the render's outlines and the pond exactly.
  Lesson: give a landmark its massing in the model before painting; photos carry materials, never the view. Mask 18.7 %.
- `liederhalle` (stuttgart-core, Liederhalle with the Hegelsaal, CinemaxX, Maritim Hotel and Alte Reithalle): one native frame
  690,-3720,1536,1024 (`--frame=`), `--base render --aerial --aerial-source city --style reference-simple.png`, NO photo refs
  (aerial tiles 1..2,-4 draped first with `aerial.ts --near 48.78082,9.16643 --source city`). The first try (massing kept,
  four photos for materials) was rejected: LoD2 massing painted literally, photos pulled the views. The Wilhelma way works:
  the prompt calls image 1 a rough massing model and the pixel-aligned orthophoto the truth for every roof, terrace and
  hedge; wall materials as text only. Key mask 16.9 %, then trimmed by hand at art x ≥ 1372 (the university blocks east
  of the Maritim, which the key kept; the unedited key is mask-key.png).
- `solitude` (stuttgart-west, Schloss Solitude and the crescent of its Kavaliershäuser): one native frame
  9209,-20812,1536,1024, `--base render --aerial --aerial-source city --style reference-simple.png`, no photo refs (aerial
  draped with `aerial.ts --near 48.7870,9.0830 --source city`). The Liederhalle prompt: render as rough massing, orthophoto
  as the truth, wall materials as text. First try accepted (match 0.87); it leaves a gap where the left arm of the crescent
  meets the upper one. Key mask 4.5 %: buildings only, the gravel court stays the render's.
- `baerenschloessle` (stuttgart-west, the Bärenschlössle above the Bärensee and its gravel terrace): one native frame
  -2488,-21170,1536,1024, same flags, aerial draped with `--near 48.76087,9.09137`. First try accepted (match 0.96); the key
  keeps the pavilion and the gravel terrace with its tables, walls and the trees on it.
- `grabkapelle` (stuttgart-east, the Grabkapelle on the Württemberg and its round terrace): one native frame
  -5044,16431,1536,1024, `--base render --aerial --aerial-source city --style reference-simple.png`, aerial draped with
  `--near 48.78204,9.26874`. First try accepted (match 0.95); the key keeps the chapel and its round terrace.
- `staatsgalerie` (stuttgart-core, the old Staatsgalerie and Stirling's Neue Staatsgalerie): one native frame
  -407,220,1536,1024, same flags (aerial already draped there). First try accepted (match 0.89): Stirling's building came
  out a little blockier than its stepped terraces, and its plain long wing on the upper left merged into the main block.
- `glaswuerfel` (stuttgart-south-west, the blue glass office tower by the Vaihingen viaduct): no overview. art.png is the
  native frame -8384,-11984,1536,1024 cropped from the window paintings of Nov 17 that were withdrawn from the area
  (`paint-withdrawn/20261126-140239/`), landmark.json written by hand (`base: render`), then `key` only. Mask 1.9 %: the
  tower alone; painted trees in front of its foot leave small notches where the render shows through.
- `flughafen-terminal` (stuttgart-south-east, Stuttgart Airport's terminal halls, gate pier and jet bridges): portrait
  frame -39700,-5560,1024,1536, `--base render --aerial --aerial-source lgl --style reference-simple.png` (the city's photos
  stop at the city boundary; LGL DOP20 was already draped there). First try accepted (match 0.66: the apron was
  repainted, the key drops it). Key mask 29.7 %: halls, glass-grid block, pier and eight jet bridges; no aircraft.
- `skyloop` (stuttgart-south-east, the figure-eight office building by the airport): native frame -38740,-4620,1536,1024,
  same flags as the terminal. First try accepted (match 0.95); the key keeps the building and its two courtyards (9.5 %).
- `schillerplatz` (stuttgart-core, the square with the Stiftskirche, Altes Schloss, Fruchtkasten, Alte Kanzlei and
  Prinzenbau): native frame -1428,-1812,1536,1024, `--aerial-source city`. First try accepted (match 0.90). Key 14.3 %;
  a stray fleck left of the square erased from the mask by hand (the unedited key is mask-key.png).
- `rathaus` (stuttgart-core, the town hall and the Marktplatz after its renovation): native frame -2068,-2102,1536,1024
  (the first frame, 350 px lower, cut the back wing at its top edge), `--aerial-source city`. The third try is the one:
  walls, tower clock, steps, beige paving and fountain field described in words from two CC BY-SA Commons photos
  (ATTRIBUTION.md; not given to the model). Match 0.83 (the square was cleared of the render's trees, as in the photos).
  The key keeps the building and the whole Marktplatz (13.7 %).
- `hauptbahnhof` (stuttgart-core, the Bonatzbau with its gutted wings and the Stuttgart 21 roof with its light eyes):
  native frame 1600,-560,1536,1024, `--base render --aerial --aerial-source city`. First try accepted (match 0.65).
  It replaces the old window-painted `hbf` lot cut-out (removed from cutouts.json; its paint-cutout-hbf/ windows kept).
  In cutouts.json before hbf-gleisvorfeld and hbf-steg.
- `hbf-gleisvorfeld` (stuttgart-core, the old terminus still in use during Stuttgart 21: platform roofs, buffer stops,
  the temporary halls): native frame 2200,-100,1536,1024, `--base render --aerial --aerial-source city`. Match 0.55
  (the roofs are new over bare tracks). One edit (`edit-bridge.txt`, box 600,420,1180,820) removed an invented
  footbridge across the tracks. Key 41.3 %, plus the strip x 2200–2218, y 300–485 by hand (grass over the render's flat
  path; the unedited key is mask-key.png). `hideTrains`: trains run under its roofs.
- `hbf-steg` (stuttgart-core, the temporary covered footbridge, OSM way 1016875485, from the Bonatzbau round the S21
  pit to the platform heads; the render draws it as a flat path): native frame 1300,-250,1536,1024, same flags. First
  try accepted (match 0.89). Key 5.6 %, cut by hand where it meets the gleisvorfeld gallery's corner: nothing at
  x ≥ 2232, nor its rising leg (x ≥ 2160, y < 482); the unedited key is mask-key.png. Last in cutouts.json, so no
  other painting's fade lies over its end.
