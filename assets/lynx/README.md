# Astra Lynx assets

This directory contains raster source material and derived mascot frame packs.

- `source/lynx-concept-reference-v1.png` is the approved raster identity reference.
- `raster/working/lynx-working-typing-sheet-v1.png` is the generated two-keyframe master sheet.
- `raster/working/lynx-working-typing-01-v1.png` and `02-v1.png` are review crops derived from that sheet.

These files are raster images generated with the built-in image generation workflow. They are not native SVG assets. Any future SVG must be a separate, reviewed vectorization and must not replace the raster provenance record.

Runtime code must consume packaged assets through a checked manifest. It must never load mascot artwork from the current workspace, a remote URL, or an unverified path.
