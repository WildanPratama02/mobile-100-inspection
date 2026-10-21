/**
 * S2 Login (FR-01, doc 05 §7): three pickers and LOGIN, nothing typed. The form starts empty on every visit,
 * because tablets are shared (U5).
 */
import { useState } from 'react';
import type { Factory, User } from '@m100/shared';
import { useDataSources } from '../app/dataSources';
import { Logo } from '../app/Logo';
import { Overlay } from '../app/Overlay';
import { useOnline } from '../app/useOnline';
import { ApiError, OfflineError, SERVER_ERROR, type MasterData } from '../data/sources';
import { useAppStore } from '../state/store';
import { Button, Chip, Dialog, Icon, List, Notice, SelectField } from '../ui';
import './screens.css';

type Picker = 'name' | 'factory' | 'cell';

export interface LoginScreenProps {
  data: Pick<MasterData, 'users' | 'factories'>;
}

export function LoginScreen({ data }: LoginScreenProps) {
  const { auth: authApi } = useDataSources();
  const login = useAppStore((s) => s.login);
  const online = useOnline();
  const [user, setUser] = useState<User | null>(null);
  const [factory, setFactory] = useState<Factory | null>(null);
  const [cell, setCell] = useState<string | null>(null);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** The last LOGIN got no answer although the tablet seemed online. */
  const [unreached, setUnreached] = useState(false);
  const [busy, setBusy] = useState(false);

  const complete = user !== null && factory !== null && cell !== null;
  const canLogin = complete && online && !busy;

  function chooseFactory(next: Factory) {
    setPicker(null);
    setProblem(null);
    if (next.factory === factory?.factory) return;
    setFactory(next);
    // Changing the factory clears the cell; a factory with one cell selects it (FR-01.3).
    setCell(next.cells.length === 1 ? next.cells[0]! : null);
  }

  async function submit() {
    if (!user || !factory || !cell) return;
    setBusy(true);
    setProblem(null);
    setUnreached(false);
    try {
      const auth = await authApi.login({
        username: user.username,
        level: user.level,
        factory: factory.factory,
        cell,
      });
      await login(auth);
    } catch (error) {
      // `USER_NOT_FOUND` / `CELL_NOT_FOUND` and any other refusal: the API's `detail` (doc 05 §7).
      if (error instanceof OfflineError) setUnreached(true);
      else setProblem(error instanceof ApiError ? error.detail : SERVER_ERROR);
      setBusy(false);
    }
  }

  const close = () => setPicker(null);

  return (
    <main className="app-screen login">
      <section className="login__brand">
        <div className="login__team">QIP Digital Team</div>
        <h1 className="login__title">
          MOBILE 100%
          <br />
          INSPECTION
          <small>Input defect tanpa keyboard</small>
        </h1>
      </section>

      <div className="login__logo">
        <Logo placement="login" alt="PT Parkland World Indonesia" />
      </div>

      <section className="login__form" aria-labelledby="login-title">
        <h2 id="login-title" className="login__heading">
          Login PSI
        </h2>

        <div className="login__name">
          <SelectField
            id="login-name"
            label="Nama"
            placeholder="Pilih nama"
            value={user?.username ?? null}
            open={picker === 'name'}
            onClick={() => setPicker('name')}
          />
          {user ? <Chip tone="role">{user.level}</Chip> : null}
        </div>
        <div className="login__pair">
          <SelectField
            id="login-factory"
            label="Factory"
            placeholder="Pilih factory"
            value={factory?.factory ?? null}
            open={picker === 'factory'}
            onClick={() => setPicker('factory')}
          />
          <SelectField
            id="login-cell"
            label="Cell"
            placeholder={factory ? 'Pilih cell' : 'Pilih factory dulu'}
            value={cell}
            open={picker === 'cell'}
            disabled={!factory}
            onClick={() => setPicker('cell')}
          />
        </div>

        {problem ? <Notice tone="danger">{problem}</Notice> : null}
        {!online || unreached ? (
          <Notice tone="warning">Login butuh koneksi. Hubungkan Wi-Fi, lalu coba lagi.</Notice>
        ) : null}
        <Button
          variant="primary"
          size="lg"
          block
          disabled={!canLogin}
          onClick={() => void submit()}
        >
          LOGIN
        </Button>
        {!complete ? <p className="login__hint">Pilih nama, factory, dan cell.</p> : null}
      </section>

      {picker === 'name' ? (
        <Overlay onDismiss={close}>
          <Dialog title="Pilih nama" onClose={close}>
            <List role="listbox" className="login__names">
              {data.users.map((u) => {
                const selected = u.username === user?.username && u.level === user.level;
                return (
                  <button
                    key={`${u.username}|${u.level}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className="m100-row login__option"
                    onClick={() => {
                      setUser(u);
                      setProblem(null);
                      close();
                    }}
                  >
                    <span className="m100-row__t">{u.username}</span>
                    <Chip tone="role">{u.level}</Chip>
                    <span className="login__check">
                      {selected ? <Icon name="check" label="Dipilih" /> : null}
                    </span>
                  </button>
                );
              })}
            </List>
          </Dialog>
        </Overlay>
      ) : null}

      {picker === 'factory' ? (
        <Overlay onDismiss={close}>
          <Dialog title="Pilih factory" onClose={close}>
            <ChoiceGrid
              options={data.factories.map((f) => f.factory)}
              selected={factory?.factory ?? null}
              onChoose={(value) => chooseFactory(data.factories.find((f) => f.factory === value)!)}
            />
          </Dialog>
        </Overlay>
      ) : null}

      {picker === 'cell' && factory ? (
        <Overlay onDismiss={close}>
          <Dialog title="Pilih cell" onClose={close}>
            <ChoiceGrid
              options={factory.cells}
              selected={cell}
              onChoose={(value) => {
                setCell(value);
                setProblem(null);
                close();
              }}
            />
          </Dialog>
        </Overlay>
      ) : null}
    </main>
  );
}

interface ChoiceGridProps {
  options: readonly string[];
  selected: string | null;
  onChoose: (value: string) => void;
}

/** Large buttons for factory and cell, the chosen one in accent (doc 05 §7). */
function ChoiceGrid({ options, selected, onChoose }: ChoiceGridProps) {
  return (
    <div className="login__grid" role="listbox">
      {options.map((value) => (
        <button
          key={value}
          type="button"
          role="option"
          aria-selected={value === selected}
          className="login__choice"
          onClick={() => onChoose(value)}
        >
          {value}
        </button>
      ))}
    </div>
  );
}
