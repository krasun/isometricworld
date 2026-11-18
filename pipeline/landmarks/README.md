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
