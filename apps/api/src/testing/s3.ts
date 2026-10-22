/**
 * Test helper: throw-away buckets on a local S3-compatible server for `S3PhotoStore` (T3.4). The server is a
 * container started by hand (CLAUDE.md, Commands), named by `TEST_S3_ENDPOINT` with `TEST_S3_ACCESS_KEY` and
 * `TEST_S3_SECRET_KEY` (environment or `apps/api/.env`). Without `TEST_S3_ENDPOINT` the S3 tests are skipped.
 */
import { randomBytes } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  paginateListObjectsV2,
  S3Client,
} from '@aws-sdk/client-s3';
import { S3PhotoStore, type S3PhotoStoreConfig } from '../photos/s3-photo-store';
import { testEnvValue } from './database';

const endpoint = testEnvValue('TEST_S3_ENDPOINT');

/** `describe` when a test S3 server is configured, else `describe.skip`. */
export const describeIfS3 = endpoint ? describe : describe.skip;

/** The test server's address and keys; throws, naming the variable, when it is not set. */
export function testS3Config(): Omit<S3PhotoStoreConfig, 'bucket'> {
  if (!endpoint) throw new Error('TEST_S3_ENDPOINT is missing: S3 tests need a test S3 server');
  return {
    endpoint,
    accessKey: testEnvValue('TEST_S3_ACCESS_KEY') ?? 'm100-test',
    secretKey: testEnvValue('TEST_S3_SECRET_KEY') ?? 'm100-test',
  };
}

export interface TestBuckets {
  /** A new empty bucket and a store on it. */
  store(): Promise<S3PhotoStore>;
  /** Empties and removes every bucket made here, and closes the stores. */
  drop(): Promise<void>;
}

export function testBuckets(): TestBuckets {
  const config = testS3Config();
  const admin = new S3Client({
    endpoint: config.endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const buckets: string[] = [];
  const stores: S3PhotoStore[] = [];
  return {
    async store() {
      const bucket = `m100-test-${process.pid}-${randomBytes(4).toString('hex')}`;
      await admin.send(new CreateBucketCommand({ Bucket: bucket }));
      buckets.push(bucket);
      const store = new S3PhotoStore({ ...config, bucket });
      stores.push(store);
      return store;
    },
    async drop() {
      for (const store of stores) store.destroy();
      for (const bucket of buckets) {
        for await (const page of paginateListObjectsV2({ client: admin }, { Bucket: bucket })) {
          for (const object of page.Contents ?? []) {
            await admin.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
          }
        }
        await admin.send(new DeleteBucketCommand({ Bucket: bucket }));
      }
      admin.destroy();
    },
  };
}
