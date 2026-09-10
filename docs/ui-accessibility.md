# Market Depth accessibility

- Semantic color is always paired with a label, icon, value, or state name.
- Primary text/surface combinations target WCAG AA; muted copy is reserved for non-critical metadata.
- Buttons and tabs expose native roles, `aria-current`, `aria-selected`, `aria-pressed`, and descriptive labels where relevant.
- Keyboard focus uses a visible cyan outline; Cmd/Ctrl-K focuses stock search.
- Mobile interactive targets target 44px minimum.
- Financial values use tabular numerals and Indian formatting.
- Charts and spatial objects expose text/ARIA summaries; interpretation never requires reading a 3D object.
- `prefers-reduced-motion` preserves information while stopping nonessential movement.
- Error, unavailable, stale, and insufficient-data states are explicit rather than represented as zero.

Remaining release check: run automated axe checks plus keyboard-only and screen-reader walkthroughs against a live backend/data set.

