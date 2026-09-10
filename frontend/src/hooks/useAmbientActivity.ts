'use client';

import { RefObject, useEffect, useState } from 'react';

/**
 * Keeps ambient visuals active only while they are visible and the document is
 * foregrounded. It deliberately does not encode any market or product state.
 */
export function useAmbientActivity<T extends HTMLElement>(ref: RefObject<T | null>) {
  const [active, setActive] = useState(true);

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;

    let intersecting = true;
    const update = () => setActive(intersecting && document.visibilityState === 'visible');
    const observer = new IntersectionObserver(
      ([entry]) => {
        intersecting = entry?.isIntersecting ?? false;
        update();
      },
      { rootMargin: '80px', threshold: 0.01 },
    );

    observer.observe(element);
    document.addEventListener('visibilitychange', update);
    update();

    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
    };
  }, [ref]);

  return active;
}
