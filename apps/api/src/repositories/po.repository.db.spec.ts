import { Database, type Queryable } from '../db/database';
import { createTestDatabase, type TestDatabase } from '../testing/database';
import { PgPoRepository, type PoInput } from './po.repository';

let db: TestDatabase;
let repo: PgPoRepository;

const POS: PoInput[] = [
  {
    po: '0902028839',
    article: 'IH1234',
    model: 'RUNNER X',
    destination: 'JAPAN ',
    orderQty: 10002,
    podd: '2026-01-12',
    crd: null,
    finished: false,
  },
  {
    po: 'CX-0902368685',
    article: 'JQ9876',
    model: 'COURT',
    destination: '',
    orderQty: 1,
    podd: null,
    crd: '2026-12-31',
    finished: null,
  },
];

beforeAll(async () => {
  db = await createTestDatabase({ migrated: true });
  repo = new PgPoRepository(new Database(db.pool('m100_app')));
});
afterAll(async () => {
  await db?.drop();
});

describe('PgPoRepository (doc 02 §3.3)', () => {
  it('imports POs and returns them byte for byte, leading zeros, prefixes and U+00A0 kept', async () => {
    expect(await repo.upsertMany(POS, 'import:ALL_PO_MASTER.csv')).toEqual({
      inserted: 2,
      updated: 0,
      unchanged: 0,
    });
    expect(await repo.findByPo('0902028839')).toEqual({
      ...POS[0],
      active: true,
      source: 'import:ALL_PO_MASTER.csv',
    });
    const cx = await repo.findByPo('CX-0902368685');
    expect(cx).toEqual({ ...POS[1], active: true, source: 'import:ALL_PO_MASTER.csv' });
  });

  it('matches the PO text exactly, not as a number', async () => {
    expect(await repo.findByPo('902028839')).toBeNull();
    expect(await repo.findByPo('cx-0902368685')).toBeNull();
  });

  it('changes nothing, not even the source, when the same rows come from another file', async () => {
    expect(await repo.upsertMany(POS, 'import:ALL_PO_MASTER_2.csv')).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 2,
    });
    expect((await repo.findByPo('0902028839'))!.source).toBe('import:ALL_PO_MASTER.csv');
  });

  it('records the source of a changed row', async () => {
    expect(await repo.upsertMany([{ ...POS[1]!, orderQty: 2 }], 'admin')).toEqual({
      inserted: 0,
      updated: 1,
      unchanged: 0,
    });
    expect(await repo.findByPo('CX-0902368685')).toMatchObject({ orderQty: 2, source: 'admin' });
  });

  it('imports many POs in chunks', async () => {
    const many: PoInput[] = Array.from({ length: 12_001 }, (_, i) => ({
      ...POS[1]!,
      po: `T-${String(i).padStart(6, '0')}`,
    }));
    expect(await repo.upsertMany(many, 'import:big.csv')).toEqual({
      inserted: 12_001,
      updated: 0,
      unchanged: 0,
    });
    expect(await repo.findByPo('T-012000')).toMatchObject({ po: 'T-012000', orderQty: 1 });
  });
});

describe('PgPoRepository.search (doc 04 §3.3)', () => {
  let searchDb: TestDatabase;
  let pos: PgPoRepository;

  const po = (fields: Partial<PoInput> & Pick<PoInput, 'po'>): PoInput => ({
    article: 'ZZ0000',
    model: 'PLAIN',
    destination: 'USA',
    orderQty: 100,
    podd: null,
    crd: null,
    finished: null,
    ...fields,
  });

  const SEARCH_POS: PoInput[] = [
    po({
      po: '0902028839',
      article: 'IH1234',
      model: 'RUNNER X',
      destination: 'JAPAN ',
      podd: '2026-01-12',
    }),
    // Holds 8839 but does not end with it.
    po({ po: '0902288390', podd: '2026-03-01' }),
    po({ po: '0901118839' }),
    po({ po: '0903338839', podd: '2026-05-01' }),
    // Only the article holds 8839.
    po({ po: '0905550001', article: 'AB8839X', podd: '2026-09-09' }),
    po({ po: 'CX-0902368685', model: 'COURT', destination: '' }),
    // Deactivated below.
    po({ po: '0909998839', podd: '2026-12-01' }),
    // "0088 39zz" only spans the space between po and article.
    po({ po: '0907770088', article: '39ZZ' }),
    po({ po: '0906660002', model: 'TEST_50%' }),
  ];
  const numbers = (found: { po: string }[]) => found.map((p) => p.po);

  beforeAll(async () => {
    searchDb = await createTestDatabase({ migrated: true });
    pos = new PgPoRepository(new Database(searchDb.pool('m100_app')));
    await pos.upsertMany(SEARCH_POS, 'import:ALL_PO_MASTER.csv');
    await searchDb.client.query(`UPDATE pos SET active = false WHERE po = '0909998839'`);
  });
  afterAll(async () => {
    await searchDb?.drop();
  });

  it('puts POs ending with the text first, then other PO matches, then article or model matches', async () => {
    // Within each group the newest PODD first, none last; the deactivated PO is left out.
    expect(numbers(await pos.search('8839', 20))).toEqual([
      '0903338839',
      '0902028839',
      '0901118839',
      '0902288390',
      '0905550001',
    ]);
  });

  it('returns at most `limit` rows', async () => {
    expect(numbers(await pos.search('8839', 2))).toEqual(['0903338839', '0902028839']);
  });

  it('matches po, article and model ignoring case, and returns the rows byte for byte', async () => {
    expect(await pos.search('cx-0902', 20)).toEqual([
      {
        po: 'CX-0902368685',
        article: 'ZZ0000',
        model: 'COURT',
        destination: '',
        orderQty: 100,
        podd: null,
        crd: null,
      },
    ]);
    expect(await pos.search('ih12', 20)).toEqual([
      {
        po: '0902028839',
        article: 'IH1234',
        model: 'RUNNER X',
        destination: 'JAPAN ',
        orderQty: 100,
        podd: '2026-01-12',
        crd: null,
      },
    ]);
  });

  it('matches a model holding U+00A0 with a space or a U+00A0 in the text', async () => {
    expect(numbers(await pos.search('runner x', 20))).toEqual(['0902028839']);
    expect(numbers(await pos.search('runner x', 20))).toEqual(['0902028839']);
  });

  it('takes %, _ and \\ literally', async () => {
    expect(numbers(await pos.search('t_50%', 20))).toEqual(['0906660002']);
    expect(await pos.search('0_0', 20)).toEqual([]);
    expect(await pos.search('9%8', 20)).toEqual([]);
    expect(await pos.search('\\90', 20)).toEqual([]);
  });

  it('does not match across the spaces that join po, article and model', async () => {
    expect(await pos.search('0088 39zz', 20)).toEqual([]);
  });

  it('uses the trigram index pos_search_trgm_idx', async () => {
    const plan = await searchDb.as('m100_app', async (client) => {
      await client.query('SET LOCAL enable_seqscan = off');
      let explained = '';
      const explaining: Queryable = {
        query: async (sql, params) => {
          const result = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params);
          explained = result.rows.map((row) => row['QUERY PLAN']).join('\n');
          return { ...result, rows: [] };
        },
      };
      await pos.search('8839', 20, explaining);
      return explained;
    });
    expect(plan).toContain('pos_search_trgm_idx');
  });
});
