import { AreaPill } from './AreaPill';
import { cx } from './cx';
import { SHOE_AREAS, SHOE_BOX, type ShoeMapArea } from './shoeLayout';

export interface ShoeMapAreaState {
  selected?: boolean;
  count?: number;
  disabled?: boolean;
}

export interface ShoeMapProps {
  src: string;
  areas?: Record<string, ShoeMapAreaState>;
  disabled?: boolean;
  onSelect?: (areaId: string) => void;
  /** Crop box [x1, y1, x2, y2] of the shoe in the 2000 × 2000 photo. */
  imageBox?: [number, number, number, number];
  layout?: ShoeMapArea[];
  label?: string;
  className?: string;
}

/** The map is drawn in a 1000 × 720 box; the shoe is 580 wide, its box starting at (210, 140). */
const MAP_W = 1000;
const MAP_H = 720;
const SHOE_W = 580;
const SHOE_X = 210;
const SHOE_Y = 140;
const PHOTO_SIZE = 2000;

export function ShoeMap({
  src,
  areas = {},
  disabled,
  onSelect,
  imageBox = SHOE_BOX,
  layout = SHOE_AREAS,
  label,
  className,
}: ShoeMapProps) {
  const off = !!disabled;
  const scale = SHOE_W / (imageBox[2] - imageBox[0]);
  const x = (px: number) => SHOE_X + (px - imageBox[0]) * scale;
  const y = (px: number) => SHOE_Y + (px - imageBox[1]) * scale;

  return (
    <div
      className={cx('m100-shoemap', off && 'm100-shoemap--off', className)}
      role="group"
      aria-label={label ?? 'Pilih area sepatu'}
    >
      <svg className="m100-shoemap__svg" viewBox={`0 0 ${MAP_W} ${MAP_H}`} aria-hidden="true">
        {src ? (
          <image
            className="m100-shoemap__img"
            href={src}
            x={x(0)}
            y={y(0)}
            width={PHOTO_SIZE * scale}
            height={PHOTO_SIZE * scale}
          />
        ) : null}
        {layout.map((area) => {
          if (!area.anchor) return null;
          const on = !!areas[area.id]?.selected;
          const ax = x(area.anchor[0]);
          const ay = y(area.anchor[1]);
          return [
            <line
              key={`l${area.id}`}
              className={cx('m100-shoemap__line', on && 'm100-shoemap__line--sel')}
              x1={area.dock[0]}
              y1={area.dock[1]}
              x2={ax}
              y2={ay}
            />,
            <circle
              key={`d${area.id}`}
              className={cx('m100-shoemap__dot', on && 'm100-shoemap__dot--sel')}
              cx={ax}
              cy={ay}
              r={on ? 7 : 5}
            />,
          ];
        })}
      </svg>
      {layout.map((area) => {
        const state = areas[area.id] ?? {};
        return (
          <AreaPill
            key={area.id}
            lines={area.lines}
            general={area.general}
            selected={state.selected}
            count={state.count}
            disabled={off || state.disabled}
            className={`m100-shoemap__pill--${area.side}`}
            onClick={onSelect ? () => onSelect(area.id) : undefined}
            style={{
              left: `${area.dock[0] / (MAP_W / 100)}%`,
              top: `${area.dock[1] / (MAP_H / 100)}%`,
            }}
          />
        );
      })}
    </div>
  );
}
