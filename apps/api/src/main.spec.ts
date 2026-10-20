import { TEST_ENV } from './testing/env';
import { readConfigOrExit } from './main';

class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function run(env: NodeJS.ProcessEnv) {
  const errors: string[] = [];
  const exit = {
    exit: (code: number): never => {
      throw new Exited(code);
    },
    writeError: (text: string) => errors.push(text),
  };
  try {
    return { config: readConfigOrExit(env, exit), code: undefined, errors };
  } catch (error) {
    if (error instanceof Exited) return { config: undefined, code: error.code, errors };
    throw error;
  }
}

describe('start-up configuration (T2.1)', () => {
  it('stops with exit code 1 and names the missing variable', () => {
    const env: NodeJS.ProcessEnv = { ...TEST_ENV };
    delete env.DATABASE_URL;
    const result = run(env);
    expect(result.code).toBe(1);
    expect(result.errors.join('')).toContain('DATABASE_URL is missing');
  });

  it('starts with a complete environment', () => {
    const result = run({ ...TEST_ENV });
    expect(result.code).toBeUndefined();
    expect(result.config?.port).toBe(3000);
    expect(result.errors).toEqual([]);
  });
});
