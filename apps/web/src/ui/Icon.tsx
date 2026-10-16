import type { SVGProps } from 'react';
import { cx } from './cx';

export type IconName =
  | 'plus'
  | 'chevron-down'
  | 'chevron-right'
  | 'back'
  | 'home'
  | 'undo'
  | 'check'
  | 'close'
  | 'camera'
  | 'download'
  | 'gear';

export interface IconProps {
  name: IconName;
  size?: number | string;
  label?: string;
  className?: string;
}

type Shape = ['path', SVGProps<SVGPathElement>] | ['circle', SVGProps<SVGCircleElement>];

/** The eleven line icons on a 24px grid (design-system Iconography). */
const ICONS: Record<IconName, Shape[]> = {
  plus: [['path', { d: 'M12 4v16M4 12h16' }]],
  'chevron-down': [['path', { d: 'M5 9l7 7 7-7' }]],
  'chevron-right': [['path', { d: 'M9 5l7 7-7 7' }]],
  back: [['path', { d: 'M15 5l-7 7 7 7' }]],
  home: [['path', { d: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z' }]],
  undo: [
    ['path', { d: 'M9 14L4 9l5-5' }],
    ['path', { d: 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11' }],
  ],
  check: [['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]],
  close: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
  camera: [
    ['path', { d: 'M4 8h3l2-3h6l2 3h3v11H4z' }],
    ['circle', { cx: 12, cy: 13, r: 3.5 }],
  ],
  download: [['path', { d: 'M12 4v11M7 11l5 5 5-5M5 20h14' }]],
  gear: [
    ['circle', { cx: 12, cy: 12, r: 8.4, strokeWidth: 3.4, strokeDasharray: '3.3 3.3' }],
    ['circle', { cx: 12, cy: 12, r: 6.6 }],
    ['circle', { cx: 12, cy: 12, r: 2.6 }],
  ],
};

export function Icon({ name, size, label, className }: IconProps) {
  return (
    <svg
      className={cx('m100-ico', className)}
      viewBox="0 0 24 24"
      style={size ? { width: size, height: size } : undefined}
      aria-hidden={label ? undefined : 'true'}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      {ICONS[name].map(([tag, attrs], i) =>
        tag === 'path' ? <path key={i} {...attrs} /> : <circle key={i} {...attrs} />,
      )}
    </svg>
  );
}
