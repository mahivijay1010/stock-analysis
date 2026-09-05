'use client';

import { useEffect, useRef } from 'react';

/**
 * 3D tilt on hover: perspective(900px) rotateX/rotateY up to ±maxDeg,
 * springing back on leave. Scaling is opt-in because scaled surfaces can
 * create transformed overflow near a viewport edge.
 * Disabled on touch devices and under prefers-reduced-motion.
 *
 * Usage: const ref = useTilt<HTMLDivElement>(); <div ref={ref} …/>
 */
export function useTilt<T extends HTMLElement = HTMLDivElement>(
  { maxDeg = 5, scale = 1 }: { maxDeg?: number; scale?: number } = {},
) {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof window.matchMedia !== 'function') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (window.matchMedia('(hover: none), (pointer: coarse)').matches) return; // touch

    let raf = 0;

    const onEnter = () => {
      el.style.willChange = 'transform';
      el.style.transition = 'transform 150ms ease-out';
      el.style.setProperty('--pointer-opacity', '1');
    };

    const onMove = (e: MouseEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const px = (e.clientX - rect.left) / rect.width - 0.5; // -0.5 .. 0.5
        const py = (e.clientY - rect.top) / rect.height - 0.5;
        const rx = (-py * maxDeg * 2).toFixed(2);
        const ry = (px * maxDeg * 2).toFixed(2);
        el.style.setProperty('--pointer-x', `${((px + 0.5) * 100).toFixed(1)}%`);
        el.style.setProperty('--pointer-y', `${((py + 0.5) * 100).toFixed(1)}%`);
        el.style.transform = `perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg) scale(${scale})`;
      });
    };

    const onLeave = () => {
      cancelAnimationFrame(raf);
      // spring back
      el.style.transition = 'transform 350ms cubic-bezier(0.22, 1, 0.36, 1)';
      el.style.transform = 'perspective(900px) rotateX(0deg) rotateY(0deg) scale(1)';
      el.style.setProperty('--pointer-opacity', '0');
      window.setTimeout(() => {
        el.style.willChange = '';
      }, 380);
    };

    el.addEventListener('mouseenter', onEnter);
    el.addEventListener('mousemove', onMove);
    el.addEventListener('mouseleave', onLeave);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('mouseenter', onEnter);
      el.removeEventListener('mousemove', onMove);
      el.removeEventListener('mouseleave', onLeave);
      el.style.transform = '';
      el.style.transition = '';
      el.style.willChange = '';
      el.style.removeProperty('--pointer-x');
      el.style.removeProperty('--pointer-y');
      el.style.removeProperty('--pointer-opacity');
    };
  }, [maxDeg, scale]);

  return ref;
}
