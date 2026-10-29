// Mobile 100% Inspection components (window.M100). Plain React 18 function components; styling comes from bundle.css + tokens.css.
type Classification = 'minor' | 'major' | 'critical' | 1 | 2 | 3;
export type IconName = 'edit' | 'plus' | 'chevron-down' | 'chevron-right' | 'back' | 'home' | 'undo' | 'check' | 'close' | 'camera' | 'download' | 'gear';
export interface IconProps { name: IconName; size?: number | string; label?: string; className?: string }
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { variant?: 'primary' | 'secondary' | 'danger'; size?: 'sm' | 'md' | 'lg'; icon?: IconName; block?: boolean }
export interface CommandButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { mode: 'rework' | 'bgrade' | 'nodefect' | 'end'; state?: 'idle' | 'active' | 'disabled' }
export interface BottomBarItem { label: string; icon?: IconName; onClick?: () => void; disabled?: boolean }
export interface BottomBarProps { items: BottomBarItem[]; label?: string; className?: string }
export interface ChipProps { tone: Classification | 'rework' | 'bgrade' | 'role' | 'neutral'; children?: React.ReactNode; className?: string }
export interface CountBadgeProps { value?: number | null; label?: string; className?: string }
export interface SelectFieldProps { label?: string; value?: string | null; placeholder?: string; open?: boolean; mono?: boolean; disabled?: boolean; id?: string; onClick?: () => void; className?: string }
export interface DialogProps { title: string; children?: React.ReactNode; onClose?: (() => void) | false; wide?: boolean; role?: 'dialog' | 'alertdialog'; className?: string }
export interface ToastProps { tone?: 'neutral' | 'error'; floating?: boolean; children?: React.ReactNode; className?: string }
export interface NoticeProps { tone?: 'warning' | 'danger'; title?: string; children?: React.ReactNode; className?: string }
export interface OutboxItemProps { po: string; time?: string; status: 'waiting' | 'sending' | 'sent' | 'failed'; reason?: string; detail?: string; className?: string }
export interface POListItemProps { po: string; sub?: string; count?: number; live?: string; selected?: boolean; onClick?: () => void; className?: string }
export interface StatRowProps { onClick?: () => void; label: string; value?: string | number | null; unit?: string; tone?: 'bad' | 'good'; className?: string }
export interface PhotoButtonProps { state?: 'add' | 'required' | 'attached'; src?: string; label?: string; onClick?: () => void; className?: string }
export interface Top5RowProps { no: number; name: string; classification: Classification; areas?: string; qty: number; photo?: PhotoButtonProps | null; flag?: string; className?: string }
export interface OptionRowProps { kind?: 'nav' | 'defect'; title: string; sub?: string; count?: number; classification?: Classification; qty?: number; flash?: boolean; disabled?: boolean; onClick?: () => void; className?: string }
export interface BreadcrumbProps { items: Array<string | { label: string; onClick?: () => void }>; className?: string }
export interface HistoryRowProps { head?: boolean; no?: number; name?: string; path?: string; classification?: Classification; qty?: number; flash?: boolean; className?: string }
export interface AreaPillProps { style?: React.CSSProperties; label?: string; lines?: string[]; selected?: boolean; count?: number; general?: boolean; disabled?: boolean; onClick?: () => void; className?: string }
export interface ListProps { children?: React.ReactNode; role?: string; className?: string }
export interface PaneProps { children?: React.ReactNode; label?: string; className?: string }
export interface ShoeMapAreaState { selected?: boolean; count?: number; disabled?: boolean }
export interface ShoeMapArea { id: string; lines: string[]; anchor: [number, number] | null; dock: [number, number]; side: 'left' | 'right' | 'top' | 'bottom'; general?: boolean }
export interface ShoeMapProps { src: string; areas?: Record<string, ShoeMapAreaState>; disabled?: boolean; onSelect?: (areaId: string) => void; imageBox?: [number, number, number, number]; layout?: ShoeMapArea[]; label?: string; className?: string }
export interface CheckboxRowProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>,'onChange'> { checked: boolean; label: string; sub?: string; onChange?: (checked: boolean) => void; className?: string }
export interface StepperProps { label?: string; value: number; min?: number; max?: number; format?: (v: number) => string; disabled?: boolean; onChange?: (v: number) => void; className?: string }
export interface NumberPadProps { label?: string; value: string; min?: number; max?: number; unit?: string; placeholder?: string; hint?: string; onChange?: (digits: string) => void; className?: string }
export declare const CheckboxRow: React.FC<CheckboxRowProps>;
export declare const Stepper: React.FC<StepperProps>;
export declare const NumberPad: React.FC<NumberPadProps>;
export declare const ShoeMap: React.FC<ShoeMapProps>;
export declare const List: React.FC<ListProps>;
export declare const Pane: React.FC<PaneProps>;
export declare const Icon: React.FC<IconProps>;
export declare const Button: React.FC<ButtonProps>;
export declare const CommandButton: React.FC<CommandButtonProps>;
export declare const BottomBar: React.FC<BottomBarProps>;
export declare const Chip: React.FC<ChipProps>;
export declare const CountBadge: React.FC<CountBadgeProps>;
export declare const SelectField: React.FC<SelectFieldProps>;
export declare const Dialog: React.FC<DialogProps>;
export declare const Toast: React.FC<ToastProps>;
export declare const Notice: React.FC<NoticeProps>;
export declare const OutboxItem: React.FC<OutboxItemProps>;
export declare const POListItem: React.FC<POListItemProps>;
export declare const StatRow: React.FC<StatRowProps>;
export declare const PhotoButton: React.FC<PhotoButtonProps>;
export declare const Top5Row: React.FC<Top5RowProps>;
export declare const OptionRow: React.FC<OptionRowProps>;
export declare const Breadcrumb: React.FC<BreadcrumbProps>;
export declare const HistoryRow: React.FC<HistoryRowProps>;
export declare const AreaPill: React.FC<AreaPillProps>;
