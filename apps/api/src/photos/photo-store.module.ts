import { Global, Module } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module';
import type { Config } from '../config/env';
import { DiskPhotoStore } from './disk-photo-store';
import { PHOTO_STORE, type PhotoStore } from './photo-store';
import { S3PhotoStore } from './s3-photo-store';

/** The `PhotoStore` chosen by `PHOTO_STORE` (doc 03 §5.1). */
export function createPhotoStore(config: Config['photoStore']): PhotoStore {
  // Release 1 uses the folder (doc 03 §5.2, decided 20 Oct 2026); S3 is built and tested, not deployed.
  return config.kind === 'disk' ? new DiskPhotoStore(config.dir) : new S3PhotoStore(config);
}

@Global()
@Module({
  providers: [
    {
      provide: PHOTO_STORE,
      useFactory: (config: Config) => createPhotoStore(config.photoStore),
      inject: [APP_CONFIG],
    },
  ],
  exports: [PHOTO_STORE],
})
export class PhotoStoreModule {}
