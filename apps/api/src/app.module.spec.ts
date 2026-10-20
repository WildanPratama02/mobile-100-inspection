import { Test } from '@nestjs/testing';
import { APP_NAME } from '@m100/shared';
import { AppModule } from './app.module';
import { APP_CONFIG } from './config/config.module';
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

  it('resolves @m100/shared from the workspace', () => {
    expect(APP_NAME).toBe('Mobile 100% Inspection');
  });
});
