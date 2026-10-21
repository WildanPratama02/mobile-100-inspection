/**
 * The `/master-data` document (doc 04 §3.2, doc 03 §5.3): every active row a tablet needs offline, cached and
 * rebuilt when `settings.master_version` changes. Each request reads the version (one small query), so an import
 * or admin change is visible at the tablet's next refresh. When the database fails, the last good copy is served;
 * with none yet, `503 DB_UNAVAILABLE`.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Area, AreaMapRow, Defect, Factory, Family, User } from '@m100/shared';
import { Database } from '../db/database';
import { ApiProblem } from '../errors/problem';
import {
  MASTER_DATA_REPOSITORY,
  type MasterDataRepository,
} from '../repositories/master-data.repository';
import { SETTINGS_REPOSITORY, type SettingsRepository } from '../repositories/settings.repository';
import { ReadinessService, RETRY_MS } from './readiness.service';

/** The `MasterData` schema of `04-openapi.yaml`, without `fetchedAt` (set per response). */
export interface MasterDataDocument {
  /** `master_version` as text; the ETag is this value in quotes. */
  version: string;
  users: User[];
  factories: Factory[];
  areas: Area[];
  families: Family[];
  defects: Defect[];
  map: AreaMapRow[];
}

@Injectable()
export class MasterDataService {
  private cache: MasterDataDocument | undefined;

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(MASTER_DATA_REPOSITORY) private readonly masterData: MasterDataRepository,
    @Inject(SETTINGS_REPOSITORY) private readonly settings: SettingsRepository,
    @Inject(ReadinessService) private readonly readiness: ReadinessService,
  ) {}

  async current(): Promise<MasterDataDocument> {
    try {
      const version = String(await this.settings.masterVersion());
      if (this.cache?.version !== version) this.cache = await this.build();
      return this.cache;
    } catch (error) {
      this.readiness.reportFailure('DB', error);
      if (this.cache) return this.cache;
      throw new ApiProblem('DB_UNAVAILABLE', { retryAfter: RETRY_MS / 1000 });
    }
  }

  /** One snapshot, so the version and the rows always belong together. */
  private build(): Promise<MasterDataDocument> {
    return this.db.transaction(
      async (tx) => {
        const version = String(await this.settings.masterVersion(tx));
        const [users, factories, areas, families, defects, map, defectFamilies] = [
          await this.masterData.activeUsers(tx),
          await this.masterData.activeFactories(tx),
          await this.masterData.activeAreas(tx),
          await this.masterData.activeFamilies(tx),
          await this.masterData.activeDefects(tx),
          await this.masterData.activeAreaMap(tx),
          await this.masterData.defectFamilies(tx),
        ];
        const familyOf = new Map(defectFamilies.map((d) => [d.defectId, d.familyId]));
        return {
          version,
          users,
          factories,
          areas,
          families,
          // A defect without any map row cannot be tapped on the tablet, and has no family to show.
          defects: defects.flatMap(({ id, name, classification }) => {
            const familyId = familyOf.get(id);
            return familyId === undefined ? [] : [{ id, name, classification, familyId }];
          }),
          map,
        };
      },
      { isolation: 'REPEATABLE READ', readOnly: true },
    );
  }
}
