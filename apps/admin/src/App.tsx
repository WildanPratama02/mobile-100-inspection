import { Pane } from '@m100/ui';
import { useLocation, type Route } from './app/router';
import { SessionProvider, useSession } from './app/session';
import { Shell } from './app/Shell';
import { Empty, LoadError, Loading } from './common/StateView';
import { Link } from './common/Link';
import { ToastProvider } from './common/toast';
import { Admins } from './screens/Admins';
import { AuditLog } from './screens/AuditLog';
import { Defects } from './screens/Defects';
import { FactoriesCells } from './screens/FactoriesCells';
import { Login } from './screens/Login';
import { Pos } from './screens/Pos';
import { PsiUsers } from './screens/PsiUsers';
import { SubmissionDetail } from './screens/SubmissionDetail';
import { Submissions } from './screens/Submissions';

function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case 'submissions':
      return <Submissions />;
    case 'submission':
      return <SubmissionDetail id={route.id} />;
    case 'psi-users':
      return <PsiUsers />;
    case 'factories':
      return <FactoriesCells />;
    case 'pos':
      return <Pos />;
    case 'defects':
      return <Defects />;
    case 'admins':
      return <Admins />;
    case 'audit-log':
      return <AuditLog />;
    case 'not-found':
      return (
        <Pane label="Halaman tidak ditemukan">
          <Empty action={<Link href="/admin/">Ke daftar submission</Link>}>
            Halaman tidak ditemukan.
          </Empty>
        </Pane>
      );
  }
}

function Gate() {
  const { state, retry } = useSession();
  const { route } = useLocation();
  switch (state.status) {
    case 'checking':
      return (
        <div className="adm-center">
          <Loading />
        </div>
      );
    case 'unavailable':
      return (
        <div className="adm-center">
          <LoadError error={state.error} onRetry={retry} />
        </div>
      );
    case 'signed-out':
      return <Login expired={state.expired} />;
    case 'signed-in':
      return (
        <Shell username={state.me.username}>
          {/* A new key per page: each screen starts fresh. */}
          <Screen key={route.name === 'submission' ? route.id : route.name} route={route} />
        </Shell>
      );
  }
}

export function App() {
  return (
    <SessionProvider>
      <ToastProvider>
        <Gate />
      </ToastProvider>
    </SessionProvider>
  );
}
