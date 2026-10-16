import { Test } from '@nestjs/testing';
import { APP_NAME } from '@m100/shared';
import { AppModule } from './app.module';

describe('AppModule', () => {
  it('compiles', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });

  it('resolves @m100/shared from the workspace', () => {
    expect(APP_NAME).toBe('Mobile 100% Inspection');
  });
});
