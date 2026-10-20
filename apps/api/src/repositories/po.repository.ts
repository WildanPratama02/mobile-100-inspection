/**
 * `pos` (doc 02 §3.3). Text is stored and returned exactly as imported: leading zeros and prefixes of `po`, and
 * non-breaking spaces in `model`, are kept (AC-03.5). The trigram search of `GET /pos` is T2.6.
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
