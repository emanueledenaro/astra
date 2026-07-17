# Lynx working/typing frame pack v1

## Outcome

This initial pack establishes a project-bound raster master and two coherent working keyframes. It was generated with the built-in image generation tool using the approved Lynx raster as an identity and style reference.

The pack is suitable for visual direction and renderer integration tests. It is not yet approved for production animation: the generated panels contain minor changes outside the paw region, so direct playback would produce subtle flicker.

## Keyframes

| Frame       | Pose                                                            | Timing |
| ----------- | --------------------------------------------------------------- | ------ |
| `typing-01` | Cream forepaw contacts the keyboard; tawny forepaw stays poised | 220 ms |
| `typing-02` | Cream forepaw lifts; tawny forepaw anchors the typing pose      | 220 ms |

Playback is a 440 ms loop. Reduced-motion mode holds `typing-01` and performs no glow pulse or paw movement.

## Visual validation

Validated by direct inspection of the generated sheet and both extracted frames:

- the same tawny lynx identity, facial proportions, black ear tufts, teal eyes, cream muzzle, and markings are preserved;
- the navy technical hoodie, cyan piping, laptop geometry, camera, crop, and palette remain coherent;
- both frames have one character, two forepaws, no duplicated limbs, no captions, and no watermark;
- both review frames are 879 x 879 RGB PNG files with the center gutter removed;
- movement reads primarily through the cream forepaw. The tawny paw moves less than originally requested;
- approximately 17% of pixels differ by more than 8 RGB levels, mostly from generative rendering variation and the paw/glow change. A production loop needs localized redraw or registration cleanup.

## Asset roles

- `assets/lynx/source/lynx-concept-reference-v1.png`: raster identity source of truth.
- `assets/lynx/raster/working/lynx-working-typing-sheet-v1.png`: generated two-panel master.
- `assets/lynx/raster/working/lynx-working-typing-01-v1.png`: first extracted keyframe.
- `assets/lynx/raster/working/lynx-working-typing-02-v1.png`: second extracted keyframe.
- `assets/lynx/raster/working/manifest.json`: names, timing, checksums, dimensions, and limitations.

Images 2.0 output is raster. No SVG is claimed or included. A future SVG would be a separate human-reviewed vectorization with its own provenance.

## Production derivation

1. Use `typing-01` as the locked master for face, ears, torso, hoodie, laptop, background, and lighting.
2. Redraw only the two forepaws and the smallest keyboard-glow region for subsequent frames.
3. Register every frame to the same 879 x 879 canvas and reject changes outside the approved motion mask.
4. Export packaged PNG frames or a lossless sprite sheet and update the manifest checksums.
5. Test the loop at 220 ms per frame and test the static reduced-motion frame independently.
6. Keep the terminal pixel-art renderer as the universal fallback when no image protocol is available.

## Final generation prompt

```text
Use case: stylized-concept
Asset type: Astra mascot working/typing animation keyframe sheet for a professional terminal developer tool
Input images: Image 1 is the identity, palette, costume, pixel-art rendering, laptop, and mood reference. Preserve these invariants aggressively.
Primary request: Create a clean horizontal two-panel sprite/keyframe sheet showing the exact same Lynx mascot typing at the same laptop. Frame 01: left paw pressing keys while right paw is slightly raised. Frame 02: right paw pressing keys while left paw is slightly raised. The motion must be subtle and loopable; everything except the forepaws and a tiny cyan keyboard glow pulse must remain visually identical.
Subject: one adult tawny Eurasian lynx with long black ear tufts, teal eyes, spotted face and forearms, cream muzzle, dark navy technical hoodie with restrained cyan piping, seated behind the same dark laptop.
Style/medium: polished hand-crafted high-resolution pixel-art illustration, crisp pixel clusters, professional and recognizable, matching Image 1; not vector art, not 3D, not anime.
Composition/framing: two equal square panels side by side with identical camera, scale, silhouette, pose, laptop geometry, lighting, and background. Waist-up three-quarter view, mascot centered, paws and keyboard fully visible. Clear gutter between panels; no panel labels.
Scene/backdrop: restrained deep navy technical studio background with minimal server-light shapes, simpler than Image 1 so the silhouette reads at small size.
Lighting/mood: focused, calm, competent; cyan screen light from below and very subtle warm edge light.
Color palette: deep navy, graphite, tawny amber fur, cream, cyan/teal accents.
Constraints: preserve identity, facial proportions, ear tufts, eye color, hoodie, laptop, tail absence from crop, camera, and palette across both panels. No extra limbs, no duplicated paws, no anatomy drift. Laptop has only one tiny cyan rectangular status mark; no words or logos.
Avoid: text, captions, labels, watermark, signature, photoreal fur, smooth vector gradients, chibi proportions, exaggerated expression, extra characters, extra devices, busy scenery, different camera angles, different outfits, panel-to-panel redesign.
```
