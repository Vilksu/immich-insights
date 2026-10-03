import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function placeTooltip(node: HTMLElement, x: number, y: number) {
  const gap = 12;
  const width = node.getBoundingClientRect().width;
  const height = node.getBoundingClientRect().height;
  const left = x + width + gap * 2 > window.innerWidth ? x - width - gap : x + gap;
  const top = y + height + gap * 2 > window.innerHeight ? y - height - gap : y + gap;
  node.style.left = `${Math.max(gap, Math.min(left, window.innerWidth - width - gap))}px`;
  node.style.top = `${Math.max(gap, Math.min(top, window.innerHeight - height - gap))}px`;
}

/** One viewport-aware tooltip for all charts, independent of panel overflow. */
export function FloatingTooltip({ x, y, children, className = '' }: { x: number; y: number; children: ReactNode; className?: string }) {
  const element = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const place = () => {
      placeTooltip(node, x, y);
      setPosition({ left: Number.parseFloat(node.style.left), top: Number.parseFloat(node.style.top) });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(node);
    window.addEventListener('resize', place);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); };
  }, [x, y]);
  return createPortal(<div ref={element} className={`heat-tooltip chart-float ${className}`} role="tooltip" style={position ? { ...position, visibility: 'visible' } : { left: 0, top: 0, visibility: 'hidden' }}>{children}</div>, document.body);
}
