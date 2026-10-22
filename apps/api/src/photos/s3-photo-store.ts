/**
 * `PhotoStore` on any S3-compatible server (doc 03 §5.2, doc 02 §7) through `@aws-sdk/client-s3` in path-style mode
 * (`S3_ENDPOINT`, `S3_BUCKET`, access key and secret). Built and tested, not deployed: release 1 uses
 * `DiskPhotoStore`. A key is the object key as is; the bucket stays private and nothing is pre-signed.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  paginateListObjectsV2,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  isPhotoKey,
  PhotoChecksumMismatch,
  PhotoNotFound,
  photoKeySegments,
  type PhotoStore,
  type ListedPhoto,
} from './photo-store';

export interface S3PhotoStoreConfig {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

/** S3-compatible servers ignore the region, but the SDK signs with one. */
const REGION = 'us-east-1';
/** A store that does not answer must fail the request well inside the tablet's 60 s (doc 03 §5.4). */
const CONNECTION_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 20_000;

const PROBE_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

export class S3PhotoStore implements PhotoStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  /** Opens no connection; an unreachable server or a missing bucket shows up in `probe` and `put`. */
  constructor(config: S3PhotoStoreConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: REGION,
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
      // The SDK's default extra checksums (CRC32 trailers) are not understood by every S3-compatible server.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      requestHandler: {
        connectionTimeout: CONNECTION_TIMEOUT_MS,
        requestTimeout: REQUEST_TIMEOUT_MS,
      },
    });
  }

  async put(key: string, jpeg: Buffer, sha256: string): Promise<void> {
    photoKeySegments(key);
    const actual = createHash('sha256').update(jpeg).digest('hex');
    if (actual !== sha256.toLowerCase()) throw new PhotoChecksumMismatch(key);
    // A put of the same key replaces the object whole and renews LastModified; S3 has no partial objects.
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: jpeg,
        ContentType: 'image/jpeg',
        // The server checks the bytes it received.
        ContentMD5: createHash('md5').update(jpeg).digest('base64'),
        Metadata: { sha256: actual },
      }),
    );
  }

  async get(key: string): Promise<Readable> {
    photoKeySegments(key);
    try {
      const { Body } = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return Body as Readable;
    } catch (error) {
      if (isNotFound(error)) throw new PhotoNotFound(key);
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    photoKeySegments(key);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    photoKeySegments(key);
    // Deleting a missing key succeeds on S3.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async probe(): Promise<void> {
    const key = `_probe/${randomUUID()}.jpg`;
    await this.put(key, PROBE_BYTES, createHash('sha256').update(PROBE_BYTES).digest('hex'));
    try {
      const read = await readAll(await this.get(key));
      if (!read.equals(PROBE_BYTES)) throw new Error('Photo store probe read back other bytes');
    } finally {
      await this.delete(key);
    }
  }

  /** Every object in the bucket whose key is a valid photo key. */
  async *list(): AsyncIterable<ListedPhoto> {
    for await (const page of paginateListObjectsV2(
      { client: this.client },
      { Bucket: this.bucket },
    )) {
      for (const object of page.Contents ?? []) {
        if (object.Key && object.LastModified && isPhotoKey(object.Key)) {
          yield { key: object.Key, lastModified: object.LastModified };
        }
      }
    }
  }

  /** Closes the client's sockets (tests and the CLI). */
  destroy(): void {
    this.client.destroy();
  }
}

/** No object under the key. A missing bucket is a broken store, not a missing photo (a HEAD has no body to tell). */
function isNotFound(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } } | undefined;
  if (e?.name === 'NoSuchBucket') return false;
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
