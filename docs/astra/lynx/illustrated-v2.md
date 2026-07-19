# Lynx identity v2 — illustrated (supersedes the pixel-art v1 direction)

Product-owner decision (2026-07-19): the pixel-art style of the v1 pack is retired as
the primary identity. The Astra mascot is a professionally illustrated flat-vector
character — reference bar: the Claude Code mascot — with situational animation. The v1
raster pack under `assets/lynx/raster` stays archived as provenance and must not be
used as a style source.

## Identity (unchanged from v1)

One adult Eurasian lynx: tawny amber fur, long black ear tufts, teal eyes, spotted face
and forearms, cream muzzle, dark navy technical hoodie with restrained cyan piping,
seated behind a dark laptop. Palette: deep navy `#0E1C30`, graphite `#222F3D`, tawny
amber `#D99A4E`, cream `#F2E3C6`, cyan `#39C0FF`, teal `#2EC4B6`.

## v2 pack (`assets/lynx/illustrated/`)

Hand-authored SVGs — no raster, no generative output. Each state is a self-contained
file with CSS keyframe animation and a `prefers-reduced-motion` static fallback.

| File | State | Motion |
| --- | --- | --- |
| `lynx-working-v2.svg` | working / typing | paws alternate on a 460 ms loop; cyan keyboard glow and lid rim pulse; occasional ear twitch |
| `lynx-thinking-v2.svg` | thinking | gaze lifts, sequential thought dots, slow head tilt |
| `lynx-verified-v2.svg` | verified | soft closed eyes, green check badge pop, slow contented nod |
| `lynx-attention-v2.svg` | attention / blocked | wide pupils, amber rim pulse, still posture |
| `lynx-logo-mark-v2.svg` | logo mark | none — head-only flat mark, transparent, favicon-ready |

`manifest.json` records role, SHA-256, and byte size for every asset. Runtime code
must consume these files only through the checked manifest — never from the current
workspace, a remote URL, or an unverified path (same rule as v1).

## Optional future refinement

An AI-generated raster illustration may later replace or complement these vectors; it
must be generated from the identity prompt in this document's history, reviewed by the
product owner, and added as a separate manifest entry with its own provenance — never
silently swapped over the vector sources. The deterministic terminal (character-cell)
Lynx remains the universal fallback where no image protocol exists.
