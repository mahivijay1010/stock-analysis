# Market Depth UI performance

## Budget decisions

- No Three.js, GSAP, image texture, video, or second chart engine was added.
- Spatial identity is CSS/SVG and contains no network requests.
- Framer Motion and Recharts were already application dependencies.
- Animations use transform/opacity; ambient scenes pause offscreen and in hidden tabs.
- The design preserves route-level React rendering and existing query caching.
- Fixed scene bounds reduce repaint area and eliminate layout movement from 3D objects.

## Targets

LCP <2.5s, INP <200ms, CLS <0.1 on a production build and representative device/network. These are targets, not claimed measurements; formal Lighthouse/RUM measurement requires the deployed production environment.

## Verification

Frontend lint and production Next build are required release gates. Browser captures verify that loading/error/empty surfaces reserve stable dimensions. If future Three.js or advanced charting is introduced, it must be dynamically imported, DPR capped, measured independently, and removable without affecting product logic.

