/**
 * Test helper: checks a real response against `docs/04-openapi.yaml` (doc 03 §8: every endpoint is validated
 * against the contract). Only for tests; not part of the build.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { Response } from 'supertest';
import { parse } from 'yaml';
import type { ProblemBody, ProblemCode } from '../errors/problem';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const SPEC_PATH = resolve(__dirname, '..', '..', '..', '..', 'docs', '04-openapi.yaml');
const SPEC_ID = 'openapi';

export const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as JsonObject;

// `strict: false`: OpenAPI keywords next to JSON Schema (e.g. `discriminator`) are not errors.
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(spec, SPEC_ID);

const compiled = new Map<string, ValidateFunction>();

/** A schema from anywhere in the spec, with its `#/…` references pointed back into the spec. */
function validatorFor(schema: Json): ValidateFunction {
  const key = JSON.stringify(schema);
  let validate = compiled.get(key);
  if (!validate) {
    validate = ajv.compile(rebase(schema) as JsonObject);
    compiled.set(key, validate);
  }
  return validate;
}

function rebase(node: Json): Json {
  if (Array.isArray(node)) return node.map(rebase);
  if (node === null || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node).map(([k, v]) => [
      k,
      k === '$ref' && typeof v === 'string' && v.startsWith('#') ? `${SPEC_ID}${v}` : rebase(v),
    ]),
  );
}

/** Follows a local `$ref` (`#/components/responses/X`) to its target. */
function deref(node: Json): JsonObject {
  const ref = (node as JsonObject)?.$ref;
  if (typeof ref !== 'string') return node as JsonObject;
  const target = ref
    .slice(2)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce<Json>((at, part) => (at as JsonObject)?.[part] ?? null, spec);
  if (target === null) throw new Error(`Unresolved $ref ${ref}`);
  return deref(target);
}

function mediaType(res: Response): string {
  return String(res.headers['content-type'] ?? '')
    .replace(/;.*$/, '')
    .trim();
}

function check(validate: ValidateFunction, value: unknown, what: string): void {
  if (!validate(value)) {
    throw new Error(`${what} does not match the spec: ${ajv.errorsText(validate.errors)}`);
  }
}

/**
 * The response is one that `04-openapi.yaml` declares for `method` + `path` (the template, e.g. `/pos/{po}`):
 * its status, content type, body schema and declared headers.
 */
export function expectMatchesSpec(res: Response, method: string, path: string): void {
  const operation = deref((spec.paths as JsonObject)?.[path] ?? null)?.[method.toLowerCase()];
  if (!operation) throw new Error(`The spec has no ${method.toUpperCase()} ${path}`);
  const declared = deref(operation).responses as JsonObject;
  const response = declared?.[String(res.status)];
  if (!response) {
    throw new Error(`The spec does not declare ${res.status} for ${method.toUpperCase()} ${path}`);
  }
  const { content, headers } = deref(response);
  if (content) {
    const media = (content as JsonObject)[mediaType(res)];
    if (!media) throw new Error(`The spec does not declare content type "${mediaType(res)}"`);
    const schema = (media as JsonObject).schema;
    if (schema) check(validatorFor(schema), res.body, 'Body');
  }
  for (const [name, header] of Object.entries((headers as JsonObject) ?? {})) {
    const value = res.headers[name.toLowerCase()];
    if (value === undefined) throw new Error(`Header ${name} is missing`);
    const schema = deref(header).schema as JsonObject | undefined;
    const typed = schema?.type === 'integer' || schema?.type === 'number' ? Number(value) : value;
    if (schema) check(validatorFor(schema), typed, `Header ${name}`);
  }
}

/** A value matches a schema of the spec, e.g. `#/components/schemas/Problem`, without a response around it. */
export function expectMatchesSchema(value: unknown, ref: string): void {
  check(validatorFor({ $ref: ref }), value, ref);
}

/**
 * An error response with no operation behind it (an unknown route, a body the parser refused): problem+json
 * matching the `Problem` schema, with the given status and code. Returns the checked body.
 */
export function expectProblem(res: Response, status: number, code: ProblemCode): ProblemBody {
  if (res.status !== status) throw new Error(`Expected status ${status}, got ${res.status}`);
  if (mediaType(res) !== 'application/problem+json') {
    throw new Error(`Expected application/problem+json, got "${mediaType(res)}"`);
  }
  check(validatorFor({ $ref: '#/components/schemas/Problem' }), res.body, 'Problem');
  const body = res.body as ProblemBody;
  if (body.code !== code) throw new Error(`Expected code ${code}, got ${body.code}`);
  if (body.status !== status) throw new Error(`Body status ${body.status} ≠ ${status}`);
  return body;
}
