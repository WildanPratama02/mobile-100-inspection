// Dev-only catalogue of the UI kit (T0.4): every component in every state its design-system README names.
// Served at /ui by `pnpm dev`; never part of the production build (see main.tsx).
import { useEffect, useState, type ReactNode } from 'react';
import {
  AreaPill,
  BottomBar,
  Breadcrumb,
  Button,
  CheckboxRow,
  Chip,
  CommandButton,
  CountBadge,
  Dialog,
  HistoryRow,
  Icon,
  List,
  Notice,
  NumberPad,
  OptionRow,
  OutboxItem,
  Pane,
  PhotoButton,
  POListItem,
  SelectField,
  ShoeMap,
  StatRow,
  Stepper,
  Toast,
  Top5Row,
  type IconName,
  type ShoeMapAreaState,
} from '../ui';
import './UiKitPage.css';

const SHOE_SRC = '/erasebg-transformed.avif';

const ICONS: IconName[] = [
  'plus',
  'chevron-down',
  'chevron-right',
  'back',
  'home',
  'undo',
  'check',
  'close',
  'camera',
  'download',
  'gear',
];

// Defect names exactly as in reference/mapping/mapping.json.
const D005 =
  'ODD PAIR (BOTH LEFT/RIGHT SHOES IN PAIR, DIFFERENT SIZE IN ONE PAIR, SHOE SIZE NOT AS LABEL/STICKER)';
const D035 = 'BROKEN STITCHING/LOOSE STITCHING/SKIPPED STITCHING/OPEN SEAM';
const D037 = 'WAVY/INCONSISTENT STITCHING';
const D039 = 'THREAD ENDS (>2mm)';
const D048 = 'OVER CEMENTING OR PRIMING ( YELLOWING OR DISCOLORATION) (>=4mm length, >=2mm width)';

type Theme = 'system' | 'light' | 'dark';

const THEMES: Array<{ id: Theme; label: string }> = [
  { id: 'system', label: 'Sistem' },
  { id: 'light', label: 'Terang' },
  { id: 'dark', label: 'Gelap' },
];

function Section({ name, children }: { name: string; children: ReactNode }) {
  return (
    <section className="uikit__section" aria-labelledby={`uikit-${name}`}>
      <h2 id={`uikit-${name}`}>{name}</h2>
      {children}
    </section>
  );
}

function State({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="uikit__state">
      <span className="uikit__label">{label}</span>
      {children}
    </div>
  );
}

export function UiKitPage() {
  const [theme, setTheme] = useState<Theme>('system');
  const [areas, setAreas] = useState<Record<string, ShoeMapAreaState>>({
    A01: { count: 2 },
    A03: { selected: true, count: 1 },
  });
  const [partial, setPartial] = useState(false);
  const [step, setStep] = useState(1);
  const [digits, setDigits] = useState('1200');
  const [toast, setToast] = useState(false);
  const [crumbs, setCrumbs] = useState(3);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(false), 1400);
    return () => window.clearTimeout(t);
  }, [toast]);

  const selectArea = (id: string) =>
    setAreas((prev) => {
      const next: Record<string, ShoeMapAreaState> = {};
      for (const [key, value] of Object.entries(prev)) next[key] = { ...value, selected: false };
      next[id] = { ...next[id], selected: true, count: (next[id]?.count ?? 0) + 1 };
      return next;
    });

  const crumbItems = [
    { label: 'Quarter', onClick: () => setCrumbs(1) },
    { label: 'Lateral Quarter', onClick: () => setCrumbs(2) },
    { label: 'Stitching' },
  ].slice(0, crumbs);

  return (
    <main className="uikit">
      <header className="uikit__head">
        <h1>UI kit</h1>
        <div className="uikit__row" role="group" aria-label="Tema">
          {THEMES.map((t) => (
            <Button
              key={t.id}
              size="sm"
              variant={theme === t.id ? 'primary' : 'secondary'}
              aria-pressed={theme === t.id}
              onClick={() => setTheme(t.id)}
            >
              {t.label}
            </Button>
          ))}
        </div>
      </header>

      <Section name="Icon">
        <div className="uikit__row">
          {ICONS.map((name) => (
            <State key={name} label={name}>
              <Icon name={name} size={28} />
            </State>
          ))}
          <State label="label (gear)">
            <Icon name="gear" size={28} label="Menu" />
          </State>
        </div>
      </Section>

      <Section name="Button">
        {(['primary', 'secondary', 'danger'] as const).map((variant) => (
          <div key={variant} className="uikit__row">
            {(['sm', 'md', 'lg'] as const).map((size) => (
              <State key={size} label={`${variant} ${size}`}>
                <Button variant={variant} size={size}>
                  {variant === 'primary' ? 'SUBMIT PO' : variant === 'danger' ? 'LOGOUT' : 'BATAL'}
                </Button>
              </State>
            ))}
            <State label={`${variant} disabled`}>
              <Button variant={variant} disabled>
                SUBMIT PO
              </Button>
            </State>
          </div>
        ))}
        <div className="uikit__row">
          <State label="icon">
            <Button icon="download">EXPORT PDF</Button>
          </State>
          <State label="icon">
            <Button icon="download">EXPORT EXCEL</Button>
          </State>
          <State label="primary icon">
            <Button variant="primary" icon="check">
              LOGIN
            </Button>
          </State>
        </div>
        <State label="lg block (ADD DEFECT bar)">
          <Button size="lg" block icon="plus">
            ADD DEFECT
          </Button>
        </State>
      </Section>

      <Section name="CommandButton">
        <State label="Tidak ada inspeksi aktif">
          <div className="uikit__row">
            <CommandButton mode="rework" />
            <CommandButton mode="bgrade" />
            <CommandButton mode="nodefect" />
            <CommandButton mode="end" state="disabled" />
          </div>
        </State>
        <State label="REWORK aktif">
          <div className="uikit__row">
            <CommandButton mode="rework" state="active" />
            <CommandButton mode="bgrade" state="disabled" />
            <CommandButton mode="nodefect" state="disabled" />
            <CommandButton mode="end" />
          </div>
        </State>
        <State label="B-GRADE aktif">
          <div className="uikit__row">
            <CommandButton mode="rework" state="disabled" />
            <CommandButton mode="bgrade" state="active" />
            <CommandButton mode="nodefect" state="disabled" />
            <CommandButton mode="end" />
          </div>
        </State>
      </Section>

      <Section name="BottomBar">
        <State label="UNDO aktif">
          <BottomBar
            items={[
              { label: 'BACK', icon: 'back' },
              { label: 'HOME', icon: 'home' },
              { label: 'UNDO', icon: 'undo' },
            ]}
          />
        </State>
        <State label="UNDO disabled">
          <BottomBar
            items={[
              { label: 'BACK', icon: 'back' },
              { label: 'HOME', icon: 'home' },
              { label: 'UNDO', icon: 'undo', disabled: true },
            ]}
          />
        </State>
      </Section>

      <Section name="Chip">
        <div className="uikit__row">
          <Chip tone="minor" />
          <Chip tone="major" />
          <Chip tone="critical" />
          <Chip tone={1} />
          <Chip tone={2} />
          <Chip tone={3} />
          <Chip tone="rework" />
          <Chip tone="bgrade" />
          <Chip tone="role">PSI LV.2</Chip>
          <Chip tone="neutral">CELL 12</Chip>
        </div>
      </Section>

      <Section name="CountBadge">
        <div className="uikit__row">
          <State label="3">
            <CountBadge value={3} label="3 defect" />
          </State>
          <State label="128">
            <CountBadge value={128} />
          </State>
          <State label="0 (kosong)">
            <CountBadge value={0} />
          </State>
          <State label="null (kosong)">
            <CountBadge value={null} />
          </State>
        </div>
      </Section>

      <Section name="SelectField">
        <div className="uikit__grid">
          <SelectField id="uikit-nama" label="Nama" placeholder="Pilih nama" />
          <SelectField id="uikit-factory" label="Factory" value="PWI-1" />
          <SelectField id="uikit-cell" label="Cell" value="C-12" open />
          <SelectField id="uikit-po" label="PO NUMBER" value="0045001234" mono />
          <SelectField id="uikit-off" label="Cell" placeholder="Pilih factory dulu" disabled />
        </div>
      </Section>

      <Section name="Dialog">
        <div className="uikit__grid">
          <Dialog title="Pilih cell" onClose={() => undefined}>
            <div className="uikit__row">
              <Button>C-11</Button>
              <Button>C-12</Button>
              <Button>C-13</Button>
            </div>
          </Dialog>
          <Dialog title="SUBMIT PO" role="alertdialog" onClose={false}>
            <p>Kirim hasil inspeksi PO 0045001234?</p>
            <div className="uikit__row uikit__row--end">
              <Button>BATAL</Button>
              <Button variant="primary">KIRIM</Button>
            </div>
          </Dialog>
        </div>
        <State label="wide (foto)">
          <Dialog title="Foto defect" wide onClose={() => undefined}>
            <img className="uikit__photo" src={SHOE_SRC} alt="Contoh foto" />
            <div className="uikit__row uikit__row--end">
              <Button variant="danger">HAPUS</Button>
              <Button icon="camera">Ganti foto</Button>
            </div>
          </Dialog>
        </State>
      </Section>

      <Section name="Toast">
        <div className="uikit__row">
          <Toast>+1 Defect</Toast>
          <Toast>+1 Defect dan B-Grade</Toast>
          <Toast>PO terkirim 14:32</Toast>
          <Toast tone="error">Menunggu koneksi</Toast>
          <Button size="sm" onClick={() => setToast(true)}>
            Tampilkan floating
          </Button>
        </div>
        {toast ? <Toast floating>Undo defect terakhir</Toast> : null}
      </Section>

      <Section name="Notice">
        <div className="uikit__grid">
          <Notice title="Foto wajib.">Tambah foto untuk setiap TOP 5 DEFECT.</Notice>
          <Notice tone="warning" title="2 PO menunggu koneksi.">
            Data terkirim otomatis saat online.
          </Notice>
          <Notice tone="danger" title="PO ditolak server.">
            Periksa data lalu kirim ulang.
          </Notice>
        </div>
      </Section>

      <Section name="OutboxItem">
        <List role="list">
          <OutboxItem po="0045001234" time="14:32" status="waiting" detail="Menunggu koneksi" />
          <OutboxItem po="0045001235" time="14:20" status="sending" />
          <OutboxItem po="0045001236" time="13:05" status="sent" />
          <OutboxItem
            po="0045001237"
            time="12:48"
            status="failed"
            reason="PO tidak ditemukan di ALL_PO_MASTER"
          />
        </List>
      </Section>

      <Section name="POListItem">
        <Pane label="Daftar PO">
          <List role="list">
            <POListItem po="0045001234" />
            <POListItem po="0045001235" sub="AIR ZOOM · Jepang" count={4} />
            <POListItem po="0045001236" sub="AIR ZOOM · Jepang" count={12} selected />
            <POListItem
              po="0045001237"
              sub="REVOLUTION · Korea"
              live="Inspeksi berjalan · REWORK"
              count={1}
            />
          </List>
        </Pane>
      </Section>

      <Section name="StatRow">
        <Pane label="Hasil">
          <StatRow label="Qty PO Order" value="2.400" />
          <StatRow label="QTY INSPECTION" value="128" onClick={() => setDigits('128')} />
          <StatRow label="Qty Defect" value="24" />
          <StatRow label="Qty A-Grade" value="104" />
          <StatRow label="Qty B-Grade" value="6" />
          <StatRow label="DEFECT RATE" value="18,8" unit="%" tone="bad" />
          <StatRow label="PASS RATE (RFT)" value="81,3" unit="%" tone="good" />
          <StatRow label="DEFECT RATE (kosong)" value={null} unit="%" />
        </Pane>
      </Section>

      <Section name="PhotoButton">
        <div className="uikit__row">
          <State label="add">
            <PhotoButton />
          </State>
          <State label="required">
            <PhotoButton state="required" />
          </State>
          <State label="attached">
            <PhotoButton state="attached" src={SHOE_SRC} />
          </State>
          <State label="attached (tanpa src)">
            <PhotoButton state="attached" />
          </State>
        </div>
      </Section>

      <Section name="Top5Row">
        <State label="PSI lv.2 (dengan foto)">
          <List role="list">
            <Top5Row
              no={1}
              name={D005}
              classification="critical"
              areas="General / QA"
              qty={9}
              photo={{ state: 'attached', src: SHOE_SRC }}
            />
            <Top5Row
              no={2}
              name={D048}
              classification="major"
              areas="Midsole, Toe Box"
              qty={6}
              photo={{ state: 'required' }}
              flag="Foto wajib"
            />
            <Top5Row no={3} name={D039} classification={1} areas="Quarter" qty={3} photo={{}} />
          </List>
        </State>
        <State label="PSI lv.1 (tanpa foto)">
          <List role="list">
            <Top5Row no={1} name={D035} classification="major" areas="Heel, Quarter" qty={9} />
            <Top5Row no={2} name={D039} classification="minor" areas="Quarter" qty={3} />
          </List>
        </State>
      </Section>

      <Section name="OptionRow">
        <div className="uikit__grid">
          <List role="list">
            <OptionRow title="Lateral Quarter" sub="9 family" count={3} />
            <OptionRow title="Medial Quarter" sub="9 family" />
            <OptionRow title="Stitching" disabled />
          </List>
          <List role="list">
            <OptionRow kind="defect" title={D039} classification="minor" />
            <OptionRow kind="defect" title={D035} classification="major" qty={2} flash />
            <OptionRow kind="defect" title={D005} classification="critical" qty={1} />
            <OptionRow kind="defect" title={D037} classification="minor" disabled />
          </List>
        </div>
      </Section>

      <Section name="Breadcrumb">
        <State label="interaktif (tap level sebelumnya)">
          <div className="uikit__row">
            <Chip tone="rework" />
            <Breadcrumb items={crumbItems} />
            {crumbs < 3 ? (
              <Button size="sm" onClick={() => setCrumbs(3)}>
                Reset
              </Button>
            ) : null}
          </div>
        </State>
        <State label="level dilewati">
          <Breadcrumb items={['General / QA', 'Mold']} />
        </State>
        <State label="satu level">
          <Breadcrumb items={['Toe Box']} />
        </State>
      </Section>

      <Section name="HistoryRow">
        <List role="list">
          <HistoryRow head />
          <HistoryRow
            no={1}
            name={D035}
            path="Quarter › Lateral Quarter · Stitching · REWORK"
            classification="major"
            qty={4}
          />
          <HistoryRow
            no={2}
            name={D048}
            path="Midsole › Midsole Body · Cement / Priming / Buffing · B-GRADE"
            classification={2}
            qty={1}
            flash
          />
        </List>
      </Section>

      <Section name="AreaPill">
        <div className="uikit__row">
          <AreaPill label="TOE BOX" />
          <AreaPill lines={['BRANDING /', 'TREATMENT']} />
          <AreaPill label="QUARTER" selected count={3} />
          <AreaPill label="HEEL" count={2} />
          <AreaPill label="GENERAL" general />
          <AreaPill label="VAMP" disabled />
        </div>
      </Section>

      <Section name="ShoeMap">
        <div className="uikit__grid uikit__grid--map">
          <State label="aktif (tap area)">
            <Pane label="Peta sepatu">
              <ShoeMap src={SHOE_SRC} areas={areas} onSelect={selectArea} />
            </Pane>
          </State>
          <State label="disabled (tidak ada inspeksi)">
            <Pane label="Peta sepatu nonaktif">
              <ShoeMap src={SHOE_SRC} disabled label="Area sepatu nonaktif" />
            </Pane>
          </State>
        </div>
      </Section>

      <Section name="CheckboxRow">
        <div className="uikit__grid">
          <CheckboxRow
            checked={partial}
            label="PO PARTIAL"
            sub="Kirim sebagian dari Qty Order"
            onChange={setPartial}
          />
          <CheckboxRow checked label="PO PARTIAL" sub="Kirim sebagian dari Qty Order" />
          <CheckboxRow checked={false} label="PO PARTIAL" disabled />
        </div>
      </Section>

      <Section name="Stepper">
        <div className="uikit__grid">
          <Stepper
            label="Partial ke"
            value={step}
            min={1}
            max={99}
            format={(v) => `P${v}`}
            onChange={setStep}
          />
          <Stepper label="Partial ke (maks)" value={99} max={99} format={(v) => `P${v}`} />
          <Stepper label="Partial ke (disabled)" value={2} format={(v) => `P${v}`} disabled />
        </div>
      </Section>

      <Section name="NumberPad">
        <div className="uikit__grid">
          <NumberPad
            label="Qty partial"
            value={digits}
            max={10002}
            unit="PASANG"
            hint="Qty Order 10.002 pasang"
            onChange={setDigits}
          />
          <NumberPad label="Kosong" value="" unit="PASANG" placeholder="0" />
          <NumberPad label="Melebihi maks" value="12000" max={10002} unit="PASANG" />
          <NumberPad label="Di bawah minimum" value="2" min={3} unit="PASANG" />
          <NumberPad label="Nol" value="0" max={10002} unit="PASANG" />
        </div>
      </Section>
    </main>
  );
}
