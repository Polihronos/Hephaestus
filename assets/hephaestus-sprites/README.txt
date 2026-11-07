HEPHAESTUS — PIXEL SPRITE PACK

60 transparent PNG frames, 10 looping GIF animations.
Every native frame is 64 x 80 pixels. Use nearest-neighbor / point filtering
and whole-number enlargement to keep the square pixels crisp.

CONTENTS

frames/             Individual transparent PNGs, numbered from 00 per action.
sheets/             Native-size transparent sprite sheets and atlas metadata.
sheets/4x/          The same sheets enlarged exactly 4x, without smoothing.
animations/         Ten individual looping GIFs at 4x size.
previews/           Labeled overview PNG and animated overview GIF.
sources/reference.png  Your original uploaded reference, unchanged.
animations.json     Frame indices, playback durations, and anchor position.
palette.json        Shared 24-color palette sampled from the original image.
generation-prompts.json  Prompts used to create the new poses.
validation.json     Export validation results.

ANIMATIONS

Walk south, southwest, west, northwest, north, northeast, east, southeast:
  6 frames per direction, 110 ms per frame (about 9.1 frames per second).
Hammer strike:
  8 frames, durations 160,110,180,65,100,120,110,160 ms.
  Impact is frame 04 (the fifth frame), with sparks.
Idle:
  4 frames, 240 ms per frame.

SHEET LAYOUT

walk-8-directions.png: 384 x 640 px, 6 columns and 8 rows.
  Row order: S, SW, W, NW, N, NE, E, SE.
hammer-strike.png: 512 x 80 px, 8 columns and 1 row.
idle.png: 256 x 80 px, 4 columns and 1 row.
hephaestus-atlas.png: 512 x 640 px, 8 columns and 8 rows.
  Indices 0–47: walk rows in the order above.
  Indices 48–55: hammer strike. Indices 56–59: idle.
  Indices 60–63 are empty padding, not animation frames.

IMPORT

Native cell size: 64 x 80. No spacing, margins, rotation, or trimming.
Feet/ground anchor: x=32, y=74 within each frame.
Use animations.json for frame order and per-frame playback durations.
The atlas JSON uses named rectangular frames and animation ranges.
Keep native sheets for importing; the 4x files and GIFs are convenient
viewing/export sizes. GIF transparency is limited to fully clear/opaque.

ART NOTES

The new poses extend the supplied Hephaestus design: gray beard and hair,
warm skin, blue smith's clothing, brown boots, and a gray forging hammer.
They are newly drawn interpretations of that reference, not pixel-identical
rearrangements of its original silhouette. Exported frames use a uniform
pixel grid and the same source-derived palette. All PNG alpha values are
0 or 255. The hammer action includes the anvil; walk and idle frames do not.
Directions are screen directions. The original reference is retained intact.
