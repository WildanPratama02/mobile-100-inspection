import type { ReactNode } from 'react';
import { cx } from './cx';

/** Defect classification as a word or as the mapping code (1 MINOR, 2 MAJOR, 3 CRITICAL). */
export type Classification = 'minor' | 'major' | 'critical' | 1 | 2 | 3;

export interface ChipProps {
  tone: Classification | 'rework' | 'bgrade' | 'role' | 'neutral';
  children?: ReactNode;
  className?: string;
}

const BY_CODE = { 1: 'minor', 2: 'major', 3: 'critical' } as const;

const WORD: Partial<Record<string, string>> = {
  minor: 'MINOR',
  major: 'MAJOR',
  critical: 'CRITICAL',
  rework: 'REWORK',
  bgrade: 'B-GRADE',
};

export function Chip({ tone, children, className }: ChipProps) {
  const name = typeof tone === 'number' ? BY_CODE[tone] : tone;
  return (
    <span className={cx('m100-chip', `m100-chip--${name}`, className)}>
      {children ?? WORD[name] ?? ''}
    </span>
  );
}
