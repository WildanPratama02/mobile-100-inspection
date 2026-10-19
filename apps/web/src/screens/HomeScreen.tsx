/**
 * S3 Home (doc 05 §8). T1.2 builds the header: the PO info strip with FACTORY/CELL, the PSI's name and
 * level, and the gear (AC-01.2, FR-02). The PO list, Top 5 and results come with T1.3.
 */
import { useState } from 'react';
import { Logo } from '../app/Logo';
import { useOnline } from '../app/useOnline';
import type { Auth } from '../db/schema';
import { Chip, Icon } from '../ui';
import { SettingsDialog } from './SettingsDialog';
import './screens.css';

export interface HomeScreenProps {
  auth: Auth;
}

export function HomeScreen({ auth }: HomeScreenProps) {
  const online = useOnline();
  const [menuOpen, setMenuOpen] = useState(false);

  const info: Array<[label: string, value: string, mono?: boolean]> = [
    ['PO NUMBER', '-', true],
    ['ARTIKEL', '-'],
    ['MODEL', '-'],
    ['DESTINATION', '-'],
    ['FACTORY/CELL', auth.cell],
  ];

  return (
    <main className="app-screen home">
      <header className="home__header">
        <Logo placement="home" />
        <dl className="home__info" aria-label="Info PO">
          {info.map(([label, value, mono]) => (
            <div key={label} className="home__meta">
              <dt>{label}</dt>
              <dd className={mono ? 'home__mono' : undefined}>{value}</dd>
            </div>
          ))}
        </dl>
        <div className="home__who" aria-label="Akun">
          {!online ? <Chip tone="neutral">Offline</Chip> : null}
          <span className="home__name">{auth.username}</span>
          <Chip tone="role">{auth.level}</Chip>
        </div>
        <button
          type="button"
          className="home__gear"
          aria-label="Pengaturan"
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(true)}
        >
          <Icon name="gear" />
        </button>
      </header>

      {menuOpen ? <SettingsDialog auth={auth} onClose={() => setMenuOpen(false)} /> : null}
    </main>
  );
}
