// ShoeMap geometry, kept apart from the component so React Fast Refresh works.

export interface ShoeMapArea {
  /** Area ID as in M100_AREA_MAP (A01 Toe Box … A12 General). */
  id: string;
  lines: string[];
  /** Spot on the photo in source pixels; `null` for General (no leader line). */
  anchor: [number, number] | null;
  /** Pill position in the 1000 × 720 map box. */
  dock: [number, number];
  side: 'left' | 'right' | 'top' | 'bottom';
  general?: boolean;
}

/** The shoe in `erasebg-transformed.avif` fills x 352–1647, y 543–1457 (design-system Shoe map image). */
export const SHOE_BOX: [number, number, number, number] = [352, 543, 1647, 1457];

/** Anchors and docks exactly as in design-system/components/bundle.js. */
export const SHOE_AREAS: ShoeMapArea[] = [
  { id: 'A06', lines: ['TONGUE'], anchor: [811, 634], dock: [170, 130], side: 'left' },
  { id: 'A08', lines: ['INSIDE'], anchor: [728, 790], dock: [170, 205], side: 'left' },
  { id: 'A05', lines: ['COLLAR'], anchor: [624, 832], dock: [170, 280], side: 'left' },
  { id: 'A04', lines: ['HEEL'], anchor: [489, 936], dock: [170, 355], side: 'left' },
  {
    id: 'A11',
    lines: ['OUTSOLE /', 'BONDING'],
    anchor: [936, 1394],
    dock: [170, 560],
    side: 'left',
  },
  { id: 'A07', lines: ['EYESTAY/LACE'], anchor: [1227, 728], dock: [616, 80], side: 'top' },
  { id: 'A02', lines: ['VAMP'], anchor: [1456, 832], dock: [830, 160], side: 'right' },
  { id: 'A01', lines: ['TOE BOX'], anchor: [1602, 884], dock: [830, 240], side: 'right' },
  {
    id: 'A09',
    lines: ['BRANDING /', 'TREATMENT'],
    anchor: [1123, 988],
    dock: [830, 330],
    side: 'right',
  },
  { id: 'A10', lines: ['MIDSOLE'], anchor: [1196, 1300], dock: [830, 480], side: 'right' },
  {
    id: 'A12',
    lines: ['GENERAL'],
    anchor: null,
    dock: [830, 620],
    side: 'right',
    general: true,
  },
  { id: 'A03', lines: ['QUARTER'], anchor: [728, 988], dock: [400, 650], side: 'bottom' },
];

/**
 * Docks for a short map (doc 05 U13): the same pills, lines and anchors, spread over the whole height so 44 px pills
 * stay apart down to a map about 226 px tall. Side pills sit far enough in to keep inside a 383 px wide map, and the
 * leader lines do not cross.
 */
const COMPACT_DOCKS: Readonly<Record<string, [number, number]>> = {
  A06: [225, 70],
  A08: [225, 210],
  A05: [225, 350],
  A04: [225, 495],
  A11: [225, 650],
  A07: [560, 150],
  A02: [775, 70],
  A01: [775, 215],
  A09: [775, 360],
  A10: [775, 505],
  A12: [775, 650],
  A03: [400, 572],
};

export const SHOE_AREAS_COMPACT: ShoeMapArea[] = SHOE_AREAS.map((area) => ({
  ...area,
  dock: COMPACT_DOCKS[area.id] ?? area.dock,
}));

/** Height of the map box the docks are placed in. */
const MAP_H = 720;
/** The gap the pill CSS leaves between a top or bottom pill and its dock. */
const PILL_GAP = 2;

/**
 * The smallest map height in CSS px at which pills `tap` px tall neither overlap their neighbours on the same side
 * nor reach past the top or bottom of the map (doc 05 G2).
 */
export function minMapHeight(layout: readonly ShoeMapArea[], tap = 44): number {
  let height = 0;
  const need = (h: number) => {
    height = Math.max(height, h);
  };
  for (const side of ['left', 'right'] as const) {
    const ys = layout
      .filter((a) => a.side === side)
      .map((a) => a.dock[1])
      .sort((a, b) => a - b);
    ys.forEach((y, i) => {
      if (i > 0) need((tap * MAP_H) / (y - ys[i - 1]!));
      need((tap / 2) * (MAP_H / y));
      need(tap / 2 / (1 - y / MAP_H));
    });
  }
  for (const { side, dock } of layout) {
    if (side === 'top') need(((tap + PILL_GAP) * MAP_H) / dock[1]);
    if (side === 'bottom') need((tap + PILL_GAP) / (1 - dock[1] / MAP_H));
  }
  return height;
}
