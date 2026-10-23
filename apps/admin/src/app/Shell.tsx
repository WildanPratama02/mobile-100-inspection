import { useState, type ReactNode } from 'react';
import { Button } from '@m100/ui';
import logoUrl from '../assets/parkland.png';
import { Link } from '../common/Link';
import { OwnPasswordDialog } from '../screens/OwnPassword';
import { BASE, routePath, useLocation, type Route } from './router';
import { useSession } from './session';

/** The navigation of doc 05 §20.1, in its order. */
const NAV: { route: Route; label: string; match: Route['name'][] }[] = [
  { route: { name: 'submissions' }, label: 'Submission', match: ['submissions', 'submission'] },
  { route: { name: 'psi-users' }, label: 'User PSI', match: ['psi-users'] },
  { route: { name: 'factories' }, label: 'Factory & cell', match: ['factories'] },
  { route: { name: 'pos' }, label: 'PO', match: ['pos'] },
  { route: { name: 'defects' }, label: 'Defect & area map', match: ['defects'] },
  { route: { name: 'admins' }, label: 'Admin', match: ['admins'] },
  { route: { name: 'audit-log' }, label: 'Audit log', match: ['audit-log'] },
];

/** Left navigation rail (a top menu below 900 px), header with logo, username and LOGOUT (doc 05 §20.1). */
export function Shell({ username, children }: { username: string; children: ReactNode }) {
  const { signOut } = useSession();
  const { route, href } = useLocation();
  // The small-screen menu is open on the page it was opened on; choosing a page closes it.
  const [menuOpenOn, setMenuOpenOn] = useState<string | null>(null);
  const menuOpen = menuOpenOn === href;
  const setMenuOpen = (open: (was: boolean) => boolean) =>
    setMenuOpenOn(open(menuOpen) ? href : null);
  const [passwordOpen, setPasswordOpen] = useState(false);

  return (
    <div className="adm-shell">
      <header className="adm-header">
        <a className="adm-skip" href="#main">
          Lewati ke konten
        </a>
        <Link href={BASE} className="adm-brand" aria-label="M100 Admin, ke Submission">
          <img src={logoUrl} alt="" className="adm-logo" />
          <span>M100 Admin</span>
        </Link>
        <Button
          size="sm"
          className="adm-menu-toggle"
          aria-expanded={menuOpen}
          aria-controls="adm-nav"
          onClick={() => setMenuOpen((o) => !o)}
        >
          MENU
        </Button>
        <div className="adm-header__user">
          <button
            type="button"
            className="adm-user"
            onClick={() => setPasswordOpen(true)}
            title="Ganti password"
            aria-label={`${username}, ganti password`}
          >
            {username}
          </button>
          <Button size="sm" onClick={() => void signOut()}>
            LOGOUT
          </Button>
        </div>
      </header>
      <nav
        id="adm-nav"
        className={menuOpen ? 'adm-nav adm-nav--open' : 'adm-nav'}
        aria-label="Menu admin"
      >
        <ul>
          {NAV.map((item) => {
            const current = item.match.includes(route.name);
            return (
              <li key={item.label}>
                <Link
                  href={routePath(item.route)}
                  className="adm-nav__link"
                  aria-current={current ? 'page' : undefined}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <main id="main" className="adm-main" tabIndex={-1}>
        {children}
      </main>
      {passwordOpen ? <OwnPasswordDialog onClose={() => setPasswordOpen(false)} /> : null}
    </div>
  );
}
