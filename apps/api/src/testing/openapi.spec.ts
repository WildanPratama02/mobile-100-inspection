import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { spec } from './openapi';

describe('docs/04-openapi.yaml', () => {
  it('is OpenAPI 3.1', () => {
    expect(spec.openapi).toBe('3.1.0');
  });

  it('compiles every component schema', () => {
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    ajv.addSchema(spec, 'openapi');
    const names = Object.keys((spec.components as { schemas: object }).schemas);
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) {
      expect(() => ajv.compile({ $ref: `openapi#/components/schemas/${name}` })).not.toThrow();
    }
  });
});
