import { Test } from '@nestjs/testing';
import { APP_NAME } from '@m100/shared';
import { AppModule } from './app.module';
import { APP_CONFIG } from './config/config.module';
import { DiskPhotoStore } from './photos/disk-photo-store';
import { PHOTO_STORE } from './photos/photo-store';
import {
  MASTER_DATA_REPOSITORY,
  PgMasterDataRepository,
} from './repositories/master-data.repository';
import {
  PgSubmissionRepository,
  SUBMISSION_REPOSITORY,
} from './repositories/submission.repository';
import { testConfig } from './testing/env';

describe('AppModule', () => {
  it('compiles and provides the validated configuration', async () => {
    const config = testConfig();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forConfig(config)],
    }).compile();
    expect(moduleRef.get(APP_CONFIG)).toBe(config);
    await moduleRef.close();
  });

  it('provides the repositories and the PhotoStore chosen by PHOTO_STORE (doc 03 §5.2)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forConfig(testConfig())],
    }).compile();
    expect(moduleRef.get(PHOTO_STORE)).toBeInstanceOf(DiskPhotoStore);
    expect(moduleRef.get(SUBMISSION_REPOSITORY)).toBeInstanceOf(PgSubmissionRepository);
    expect(moduleRef.get(MASTER_DATA_REPOSITORY)).toBeInstanceOf(PgMasterDataRepository);
    // Closing ends the pool, which never connected.
    await moduleRef.close();
  });

  it('resolves @m100/shared from the workspace', () => {
    expect(APP_NAME).toBe('Mobile 100% Inspection');
  });
});
