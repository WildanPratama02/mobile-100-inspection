/**
 * `pos` (doc 02 §3.3). Text is stored and returned exactly as imported: leading zeros and prefixes of `po`, and
 * non-breaking spaces in `model`, are kept (AC-03.5).
 */
import type { Po } from '@m100/shared';
import type { Database, Queryable } from '../db/database';
import { upsert, type UpsertCounts } from './upsert';

export const PO_REPOSITORY = Symbol('PoRepository');

export interface PoInput extends Po {
  /** From the old `FINISH PRODUCTION` / `Balance Prod`, `null` when not imported (PRD OQ-06). */
  finished: boolean | null;
}

export interface PoRecord extends PoInput {
  active: boolean;
  /** `import:<file>` or `admin`. */
  source: string;
}

export interface PoRepository {
  /** The PO, active or not (a submission check needs to tell "unknown" from "deactivated"). */
  findByPo(po: string, q?: Queryable): Promise<PoRecord | null>;
  /**
   * Active POs whose `po`, `article` or `model` contains `text`, ignoring case, at most `limit` (doc 04 §3.3). PSI
   * mostly type the last digits of a PO, so POs ending with `text` come first, then other `po` matches, then
   * article/model matches; within each, the newest PODD first (none last), then `po`.
   */
  search(text: string, limit: number, q?: Queryable): Promise<Po[]>;
  /** The same match and order over every PO, active or not, with its bookkeeping columns (admin search, doc 05 §20.5). */
  searchAll(text: string, limit: number, q?: Queryable): Promise<PoRecord[]>;
  /**
   * Upserts by `po`; `source` is `import:<file>` or `admin` and is recorded only on rows that are new or changed.
   * `active` of an existing row is left as it is.
   */
  upsertMany(rows: readonly PoInput[], source: string, q?: Queryable): Promise<UpsertCounts>;
}

export class PgPoRepository implements PoRepository {
  constructor(private readonly db: Database) {}

  async findByPo(po: string, q: Queryable = this.db): Promise<PoRecord | null> {
    // Dates as text: the pg driver would turn a date into a local-midnight Date.
    const { rows } = await q.query<PoRecord>(
      `SELECT po, article, model, destination, order_qty AS "orderQty",
              to_char(podd, 'YYYY-MM-DD') AS podd, to_char(crd, 'YYYY-MM-DD') AS crd,
              finished, active, source
         FROM pos WHERE po = $1`,
      [po],
    );
    return rows[0] ?? null;
  }

  search(text: string, limit: number, q: Queryable = this.db): Promise<Po[]> {
    return this.match<Po>(text, limit, false, q);
  }

  searchAll(text: string, limit: number, q: Queryable = this.db): Promise<PoRecord[]> {
    return this.match<PoRecord>(text, limit, true, q);
  }

  private async match<R extends Po>(
    text: string,
    limit: number,
    all: boolean,
    q: Queryable,
  ): Promise<R[]> {
    // `%`, `_` and `\` are literal; the text is lowered and its U+00A0 replaced in SQL, the same way as the
    // indexed expression of `pos_search_trgm_idx`, which the first condition repeats exactly to hit the index.
    // The per-field recheck drops a match that only spans the spaces joining po, article and model.
    const literal = text.replace(/[\\%_]/g, '\\$&');
    const { rows } = await q.query<R>(
      `SELECT po, article, model, destination, order_qty AS "orderQty",
              to_char(podd, 'YYYY-MM-DD') AS podd, to_char(crd, 'YYYY-MM-DD') AS crd
              ${all ? ', finished, active, source' : ''}
         FROM pos
        WHERE ($4::boolean OR active)
          AND lower(replace(po || ' ' || article || ' ' || model, U&'\\00A0', ' '))
              LIKE lower(replace($1, U&'\\00A0', ' '))
          AND (lower(po) LIKE lower(replace($1, U&'\\00A0', ' '))
               OR lower(article) LIKE lower(replace($1, U&'\\00A0', ' '))
               OR lower(replace(model, U&'\\00A0', ' ')) LIKE lower(replace($1, U&'\\00A0', ' ')))
        ORDER BY CASE
                   WHEN lower(po) LIKE lower(replace($2, U&'\\00A0', ' ')) THEN 0
                   WHEN lower(po) LIKE lower(replace($1, U&'\\00A0', ' ')) THEN 1
                   ELSE 2
                 END,
                 podd DESC NULLS LAST, po
        LIMIT $3`,
      [`%${literal}%`, `%${literal}`, limit, all],
    );
    return rows;
  }

  upsertMany(
    rows: readonly PoInput[],
    source: string,
    q: Queryable = this.db,
  ): Promise<UpsertCounts> {
    const data = ['article', 'model', 'destination', 'order_qty', 'podd', 'crd', 'finished'];
    return upsert(
      q,
      {
        table: 'pos',
        key: ['po'],
        columns: [
          { name: 'po', type: 'text', value: (r) => r.po },
          { name: 'article', type: 'text', value: (r) => r.article },
          { name: 'model', type: 'text', value: (r) => r.model },
          { name: 'destination', type: 'text', value: (r) => r.destination },
          { name: 'order_qty', type: 'integer', value: (r) => r.orderQty },
          { name: 'podd', type: 'date', value: (r) => r.podd },
          { name: 'crd', type: 'date', value: (r) => r.crd },
          { name: 'finished', type: 'boolean', value: (r) => r.finished },
          { name: 'source', type: 'text', value: () => source },
        ],
        update: [...data, 'source'],
        compare: data,
      },
      rows,
    );
  }
}
