import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  Breadcrumb,
  CheckboxRow,
  Chip,
  CommandButton,
  CountBadge,
  Dialog,
  NumberPad,
  OptionRow,
  OutboxItem,
  PhotoButton,
  POListItem,
  ShoeMap,
  StatRow,
  Stepper,
  Top5Row,
} from '.';

function Pad({ initial = '', max }: { initial?: string; max?: number }) {
  const [value, setValue] = useState(initial);
  return <NumberPad value={value} max={max} unit="PASANG" onChange={setValue} />;
}

const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const readout = () => document.querySelector('.m100-pad__out')!.firstChild!.textContent;

describe('CountBadge', () => {
  it('renders nothing for 0 or an empty value', () => {
    const { container } = render(
      <>
        <CountBadge value={0} />
        <CountBadge value={null} />
        <CountBadge />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the number with its screen-reader label', () => {
    render(<CountBadge value={3} label="3 defect" />);
    expect(screen.getByLabelText('3 defect')).toHaveTextContent('3');
  });
});

describe('StatRow', () => {
  it('shows "—" and no unit for a null value', () => {
    render(<StatRow label="DEFECT RATE" value={null} unit="%" />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('%')).not.toBeInTheDocument();
  });

  it('shows the formatted value with its unit and tone', () => {
    const { container } = render(<StatRow label="DEFECT RATE" value="18,8" unit="%" tone="bad" />);
    expect(container.firstChild).toHaveClass('m100-stat--bad');
    expect(container.querySelector('b')).toHaveTextContent('18,8%');
  });
});

describe('NumberPad', () => {
  it('builds the value from key presses and shows id-ID thousands dots', () => {
    render(<Pad />);
    for (const k of ['1', '2', '0', '0']) press(k);
    expect(readout()).toBe('1.200');
  });

  it('drops a leading zero', () => {
    render(<Pad initial="0" />);
    press('5');
    expect(readout()).toBe('5');
  });

  it('accepts at most 9 digits', () => {
    render(<Pad initial="123456789" />);
    press('1');
    expect(readout()).toBe('123.456.789');
  });

  it('HAPUS clears all and the back key removes one digit', () => {
    render(<Pad initial="1234" />);
    press('Hapus satu angka');
    expect(readout()).toBe('123');
    press('HAPUS');
    expect(readout()).toBe('0'); // placeholder
  });

  it('flags a value above max with the maximum in id-ID format', () => {
    render(<Pad initial="12000" max={10002} />);
    expect(screen.getByText('Maksimum 10.002 pasang')).toHaveClass('m100-pad__msg--bad');
    expect(document.querySelector('.m100-pad__out')).toHaveClass('m100-pad__out--bad');
  });

  it('flags a value below 1', () => {
    render(<Pad initial="0" max={10002} />);
    expect(screen.getByText('Minimal 1 pasang')).toHaveClass('m100-pad__msg--bad');
  });
});

describe('Stepper', () => {
  it('disables − at min and + at max, and steps by one', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Stepper value={1} min={1} max={99} onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Kurangi' })).toBeDisabled();
    press('Tambah');
    expect(onChange).toHaveBeenCalledWith(2);

    rerender(<Stepper value={99} min={1} max={99} format={(v) => `P${v}`} onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Tambah' })).toBeDisabled();
    expect(screen.getByText('P99')).toBeInTheDocument();
  });
});

describe('CheckboxRow', () => {
  it('toggles through onChange and reports its state', () => {
    const onChange = vi.fn();
    render(<CheckboxRow checked={false} label="PO PARTIAL" onChange={onChange} />);
    const box = screen.getByRole('checkbox', { name: 'PO PARTIAL' });
    expect(box).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('does not change while disabled', () => {
    const onChange = vi.fn();
    render(<CheckboxRow checked label="PO PARTIAL" disabled onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('CommandButton', () => {
  it('labels each mode with the fixed English words', () => {
    render(
      <>
        <CommandButton mode="rework" />
        <CommandButton mode="bgrade" />
        <CommandButton mode="nodefect" />
        <CommandButton mode="end" />
      </>,
    );
    for (const name of ['REWORK', 'B-GRADE', 'NO DEFECT', 'END INSPECTION']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('marks the active command pressed and disables on state', () => {
    render(
      <>
        <CommandButton mode="rework" state="active" />
        <CommandButton mode="bgrade" state="disabled" />
        <CommandButton mode="end" />
      </>,
    );
    expect(screen.getByRole('button', { name: 'REWORK' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'B-GRADE' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'END INSPECTION' })).not.toHaveAttribute(
      'aria-pressed',
    );
  });
});

describe('Breadcrumb', () => {
  it('marks the last crumb current and only earlier crumbs navigate', () => {
    const back = vi.fn();
    const last = vi.fn();
    render(
      <Breadcrumb
        items={[
          { label: 'Quarter', onClick: back },
          { label: 'Stitching', onClick: last },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Quarter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stitching' }));
    expect(back).toHaveBeenCalledOnce();
    expect(last).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Stitching' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

describe('Chip', () => {
  it('writes the classification word for names and mapping codes', () => {
    render(
      <>
        <Chip tone={1} />
        <Chip tone="major" />
        <Chip tone={3} />
        <Chip tone="bgrade" />
        <Chip tone="role">PSI LV.2</Chip>
      </>,
    );
    expect(screen.getByText('MINOR')).toHaveClass('m100-chip--minor');
    expect(screen.getByText('MAJOR')).toHaveClass('m100-chip--major');
    expect(screen.getByText('CRITICAL')).toHaveClass('m100-chip--critical');
    expect(screen.getByText('B-GRADE')).toHaveClass('m100-chip--bgrade');
    expect(screen.getByText('PSI LV.2')).toHaveClass('m100-chip--role');
  });
});

describe('Top5Row', () => {
  it('drops the photo column without a photo (PSI lv.1)', () => {
    const { container } = render(<Top5Row no={1} name="X" classification="minor" qty={2} />);
    expect(container.firstChild).toHaveClass('m100-t5--nophoto');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the photo control for PSI lv.2', () => {
    render(
      <Top5Row no={1} name="X" classification="minor" qty={2} photo={{ state: 'required' }} />,
    );
    expect(screen.getByRole('button', { name: 'Foto wajib' })).toBeInTheDocument();
  });

  it('shows a flag beside the areas', () => {
    const { container } = render(
      <Top5Row no={1} name="X" classification="minor" qty={2} flag="Foto wajib" />,
    );
    expect(container.querySelector('.m100-t5__flag')).toHaveTextContent('Foto wajib');
  });
});

describe('PhotoButton', () => {
  it('names each state for screen readers', () => {
    render(
      <>
        <PhotoButton />
        <PhotoButton state="required" />
        <PhotoButton state="attached" src="/x.avif" />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Tambah foto' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Foto wajib' })).toHaveClass('m100-photo--required');
    expect(screen.getByRole('button', { name: 'Lihat foto' })).toHaveClass('m100-photo--attached');
  });
});

describe('OptionRow', () => {
  it('shows the classification and tap count of a defect row', () => {
    render(<OptionRow kind="defect" title="THREAD ENDS (>2mm)" classification={1} qty={2} flash />);
    const row = screen.getByRole('button');
    expect(row).toHaveTextContent('THREAD ENDS (>2mm)MINOR2');
    expect(row).toHaveClass('m100-flash');
  });

  it('shows a disabled nav row with its count', () => {
    render(<OptionRow title="Lateral Quarter" count={3} disabled />);
    expect(screen.getByRole('button')).toBeDisabled();
    expect(screen.getByText('3')).toHaveClass('m100-row__n');
  });
});

describe('POListItem and OutboxItem', () => {
  it('marks the selected PO and labels its count', () => {
    render(<POListItem po="0045001234" count={4} selected />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByLabelText('4 defect')).toBeInTheDocument();
  });

  it('writes the outbox status in Indonesian', () => {
    render(
      <>
        <OutboxItem po="1" status="waiting" />
        <OutboxItem po="2" status="sending" />
        <OutboxItem po="3" status="sent" />
        <OutboxItem po="4" status="failed" reason="Ditolak" />
      </>,
    );
    for (const word of ['Menunggu', 'Mengirim', 'Terkirim', 'Gagal', 'Ditolak']) {
      expect(screen.getByText(word)).toBeInTheDocument();
    }
  });
});

describe('Dialog', () => {
  it('hides the close button when the dialog must be answered', () => {
    render(
      <Dialog title="SUBMIT PO" role="alertdialog" onClose={false}>
        body
      </Dialog>,
    );
    expect(screen.getByRole('alertdialog', { name: 'SUBMIT PO' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tutup' })).not.toBeInTheDocument();
  });

  it('closes through the Tutup button', () => {
    const onClose = vi.fn();
    render(<Dialog title="Pilih cell" onClose={onClose} />);
    press('Tutup');
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('ShoeMap', () => {
  it('has 12 pills and 11 leader lines (General has none)', () => {
    const { container } = render(<ShoeMap src="/erasebg-transformed.avif" />);
    expect(screen.getAllByRole('button')).toHaveLength(12);
    expect(container.querySelectorAll('line')).toHaveLength(11);
    expect(screen.getByRole('button', { name: 'GENERAL' })).toHaveClass('m100-pill--general');
    expect(container.querySelector('image')).toHaveAttribute('href', '/erasebg-transformed.avif');
  });

  it('greys every pill and dims the photo while disabled', () => {
    const { container } = render(<ShoeMap src="/s.avif" disabled />);
    for (const pill of screen.getAllByRole('button')) expect(pill).toBeDisabled();
    expect(container.firstChild).toHaveClass('m100-shoemap--off');
  });

  it('reports the area ID and shows selection and counts', () => {
    const onSelect = vi.fn();
    render(
      <ShoeMap src="/s.avif" areas={{ A03: { selected: true, count: 2 } }} onSelect={onSelect} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'TOE BOX' }));
    expect(onSelect).toHaveBeenCalledWith('A01');
    const quarter = screen.getByRole('button', { name: 'QUARTER' });
    expect(quarter).toHaveAttribute('aria-pressed', 'true');
    expect(quarter).toHaveTextContent('QUARTER2');
  });
});
