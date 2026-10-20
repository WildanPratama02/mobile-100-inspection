import { Database } from '../db/database';
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
