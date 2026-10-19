import { Chip, type Classification } from './Chip';
import { cx } from './cx';
import { PhotoButton, type PhotoButtonProps } from './PhotoButton';

export interface Top5RowProps {
  no: number;
  name: string;
  classification: Classification;
  areas?: string;
  qty: number;
  /** PSI lv.2 only; without it the photo column is dropped. */
  photo?: PhotoButtonProps | null;
  /** A short danger note beside the areas: "Foto wajib" (doc 05 §8.3). */
  flag?: string;
  className?: string;
}

export function Top5Row({
  no,
  name,
  classification,
  areas,
  qty,
  photo,
  flag,
  className,
}: Top5RowProps) {
  const hasPhoto = photo != null;
  return (
    <div className={cx('m100-t5', !hasPhoto && 'm100-t5--nophoto', className)}>
      <div className="m100-t5__no">{no}</div>
      <div className="m100-t5__nm">
        {name}
        <small>
          <Chip tone={classification} />
          {areas}
          {flag ? <em className="m100-t5__flag">{flag}</em> : null}
        </small>
      </div>
      <div className="m100-t5__q">{qty}</div>
      {hasPhoto ? (
        <div>
          <PhotoButton {...photo} />
        </div>
      ) : null}
    </div>
  );
}
