# Lynx mascot presentation contract

Lynx is an operational status surface, not decoration. Its state must always come from an observed TUI or Astra operation projection. A caller must not select a reassuring state from command output alone.

## Hybrid asset model

The universal renderer is the terminal pixel-art component in `src/component/lynx.tsx`. It requires no image protocol, remains available in small terminals, and is the mandatory fallback.

The optional illustrated renderer uses packaged raster frames. The original Images 2.0 concept is a raster illustration and must not be described as native SVG. The intended production pipeline is:

1. a reviewed high-resolution raster illustration as the visual source of truth;
2. an optional, separately reviewed SVG vectorization for scalable editing;
3. deterministic PNG frame exports or sprite sheets for terminal image renderers;
4. a manifest that maps the frame IDs in `LYNX_SEQUENCES` to packaged files and checksums.

The repository includes a reviewed raster identity reference and a two-frame working concept pack under `assets/lynx`. The manifest marks it `concept-keyframes-not-runtime-wired` because generative variation still causes visible flicker. No production SVG vectorization or terminal image-protocol adapter is checked in yet. Workspace-controlled files must never be loaded as mascot assets.

## State contract

| State               | Required evidence                                   | Illustrated sequence                               | Terminal fallback               |
| ------------------- | --------------------------------------------------- | -------------------------------------------------- | ------------------------------- |
| `initializing`      | Sync or model catalog is not ready                  | `initializing-01/02`; 600 ms loop                  | Static starting pose            |
| `idle`              | No active work after required home data is ready    | `idle-01`, blink, `idle-01`; 1600/120/1600 ms loop | Static idle pose                |
| `read-only`         | Workspace projection explicitly says read-only      | `read-only-01`; static                             | Static read-only pose           |
| `working`           | Session or operation projection is active           | `typing-01/02`; 220 ms loop                        | Two typing-paw frames at 220 ms |
| `retrying`          | Session projection reports a scheduled retry        | `retrying-01/02`; 600 ms loop                      | Static retry pose               |
| `awaiting-decision` | A real permission, question, or approval is pending | `awaiting-01/02`; 600 ms loop                      | Static attention pose           |
| `blocked`           | Policy or execution projection is blocked           | `blocked-01`; static                               | Static stop pose                |
| `success`           | Operation projection is completed                   | `success-01/02/03`; 160/160 ms, then hold          | Static done pose                |
| `uncertain`         | Reconciliation or insufficient evidence             | `uncertain-01/02`; 600 ms loop                     | Static question pose            |
| `error`             | Explicit failure projection                         | `error-01`; static                                 | Static error pose               |

`success` means completed, not verified. The mascot must never display or imply `VERIFIED`; that label belongs to the operation projection only when independent evidence supports it.

## Accessibility and motion

- Every pose always renders a plain-text label; compact layouts use a shorter label, so color and imagery are never the only signal.
- Constrained call sites may hide the visual with `showVisual=false`, but the state label remains mandatory.
- `animations_enabled=false`, `animate=false`, or an image backend without animation support selects a stable frame.
- Reduced motion disables typing, blinking, pulsing, and success transitions.
- `NO_COLOR` removes semantic colors from the terminal renderer without changing labels.
- Full pixel art is 30 columns wide. The compact renderer is the fallback for constrained layouts.

## Future image backend hook

`Lynx.renderIllustration` is the renderer-neutral integration point. A future capability provider should detect and own Kitty, Sixel, iTerm2 inline-image, or any later backend. It should return a visual only when the selected protocol and packaged frame are both usable. Returning `undefined` keeps the terminal pixel-art fallback.

Capability detection, image transmission, cache cleanup, and terminal-specific lifecycle must stay outside the mascot state model. The backend must preserve the component's text label and must not load remote or workspace-controlled assets.
