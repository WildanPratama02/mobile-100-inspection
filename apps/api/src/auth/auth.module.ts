import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module';
import type { Config } from '../config/env';
import { MasterDataModule } from '../master-data/master-data.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { DeviceKeyGuard } from './device-key.guard';
import { TokenSigner } from './jwt';
import { readJwtKey } from './jwt-key';
import { TabletTokens } from './tablet-token';
import { TokenGuard } from './token.guard';

/**
 * `AuthModule` of doc 03 §5.1, tablet half: the device key and token guards (bound globally by `AppModule`, in
 * order), `/auth/login` and `/auth/refresh`. The signing key is read from `JWT_KEY_FILE` at start-up.
 */
@Module({
  imports: [MasterDataModule],
  controllers: [AuthController],
  providers: [
    {
      provide: TokenSigner,
      useFactory: (config: Config) => new TokenSigner(readJwtKey(config.jwtKeyFile)),
      inject: [APP_CONFIG],
    },
    TabletTokens,
    AuthService,
    DeviceKeyGuard,
    TokenGuard,
  ],
  exports: [DeviceKeyGuard, TokenGuard, TabletTokens],
})
export class AuthModule {}
