import { cx } from './cx';
import { Icon, type IconName } from './Icon';

export interface BottomBarItem {
  label: string;
  icon?: IconName;
  onClick?: () => void;
  disabled?: boolean;
}

export interface BottomBarProps {
  items: BottomBarItem[];
  label?: string;
  className?: string;
}

export function BottomBar({ items, label, className }: BottomBarProps) {
  return (
    <nav className={cx('m100-bar', className)} aria-label={label ?? 'Navigasi'}>
      {items.map((item, i) => (
        <button key={i} type="button" onClick={item.onClick} disabled={item.disabled}>
          {item.icon ? <Icon name={item.icon} /> : null}
          {item.label}
        </button>
      ))}
    </nav>
  );
}
