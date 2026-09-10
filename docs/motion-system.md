# Market Depth motion system

Motion communicates a change; it is not ambient decoration.

## Tokens

- Micro interaction: 150ms.
- Card/status transition: 220–240ms.
- Page transition: 300ms.
- Number/data change: 460–500ms.
- Stagger: 75ms.
- Ambient prism/radar breath: 8–10 seconds, small translation only.

The shared contract is `MOTION_TOKENS` in `frontend/src/lib/design-tokens.ts` and the Framer Motion wrappers in `frontend/src/components/motion.tsx`.

## Rules

- Animate opacity and transform; avoid layout dimensions, blur loops, and large animated shadows.
- Radar sweep runs only while a scan is active. Its inactive state breathes slowly.
- AI status illuminates named evidence stages; it never presents hidden reasoning.
- Price/rank/status animations must be triggered by a real value change, never by a timer.
- Profit and loss transitions remain quiet: no flashes, confetti, or celebration.

## Lifecycle and accessibility

`useAmbientActivity` pauses semantic 3D animation while offscreen or when the document is hidden. `prefers-reduced-motion` disables ambient motion, skeleton breathing, evidence-stage movement, and chart draw-in while preserving all labels and values.

