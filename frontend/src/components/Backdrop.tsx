/**
 * Fixed full-viewport aurora backdrop: a slow-breathing gradient mesh, four
 * drifting blurred blobs, a faint dot-grid texture, 3% film-grain noise and a
 * soft vignette that draws the eye to the content column. Rendered once in
 * layout.tsx behind everything (z-0); content sits above at z-10. Pure CSS
 * animation — pauses under prefers-reduced-motion (see globals.css).
 */
export function Backdrop() {
  return (
    <div className="aurora-layer" aria-hidden>
      <div className="aurora-mesh" />
      <div className="aurora-blob aurora-a" />
      <div className="aurora-blob aurora-b" />
      <div className="aurora-blob aurora-c" />
      <div className="aurora-blob aurora-d" />
      <div className="prism-field">
        <span className="prism-ribbon prism-ribbon-a" />
        <span className="prism-ribbon prism-ribbon-b" />
        <span className="prism-ribbon prism-ribbon-c" />
      </div>
      <div className="depth-grid" />
      <div className="aurora-grid" />
      <div className="aurora-noise" />
      <div className="aurora-vignette" />
    </div>
  );
}
