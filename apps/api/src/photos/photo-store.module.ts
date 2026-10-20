import { Global, Module } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module';
import type { Config } from '../config/env';
import { DiskPhotoStore } from './disk-photo-store';
import { PHOTO_STORE, type PhotoStore } from './photo-store';

/** The `PhotoStore` chosen by `PHOTO_STORE` (doc 03 §5.1). */
export function createPhotoStore(config: Config['photoStore']): PhotoStore {
  if (config.kind === 'disk') return new DiskPhotoStore(config.dir);
  // Release 1 uses the folder (doc 03 §5.2, decided 20 Oct 2026); the S3 variant is the optional T3.4.
  throw new Error('PHOTO_STORE=s3: S3PhotoStore is not built yet (T3.4); use PHOTO_STORE=disk');
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
