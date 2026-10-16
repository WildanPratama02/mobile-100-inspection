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
