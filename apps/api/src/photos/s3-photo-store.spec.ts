import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describePhotoStore, jpeg, photoKey, sha256 } from '../testing/photo-store-contract';
import { describeIfS3, testBuckets, testS3Config, type TestBuckets } from '../testing/s3';
import { S3PhotoStore } from './s3-photo-store';

const config = (endpoint: string) => ({
  endpoint,
  bucket: 'm100-photos',
  accessKey: 'test-access',
  secretKey: 'test-secret',
});

describeIfS3('S3PhotoStore on a test S3 server', () => {
  let buckets: TestBuckets;
  beforeAll(() => {
    buckets = testBuckets();
  });
  afterAll(async () => {
    await buckets?.drop();
  });

  describePhotoStore('S3PhotoStore', () => buckets.store());

  it('fails the probe and a put when the bucket does not exist', async () => {
    const store = new S3PhotoStore({ ...testS3Config(), bucket: 'm100-test-missing-bucket' });
    try {
      await expect(store.probe()).rejects.toThrow();
      const bytes = jpeg('x');
      await expect(store.put(photoKey(), bytes, sha256(bytes))).rejects.toThrow();
    } finally {
      store.destroy();
    }
  });
});

describe('S3PhotoStore requests (no S3 server needed)', () => {
  let server: Server;
  let endpoint: string;
  const seen: { method: string; url: string; headers: IncomingMessage['headers'] }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers });
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { ETag: '"0"' });
        res.end();
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((done) => server.close(done));
  });
  beforeEach(() => {
    seen.length = 0;
  });

  it('sends nothing when constructed', () => {
    new S3PhotoStore(config(endpoint)).destroy();
    expect(seen).toEqual([]);
  });

  it('addresses the bucket in the path, not the host name, and sends the JPEG with its MD5', async () => {
    const store = new S3PhotoStore(config(endpoint));
    try {
      const key = photoKey('D035');
      const bytes = jpeg(key);
      await store.put(key, bytes, sha256(bytes));
      expect(seen).toHaveLength(1);
      const [request] = seen;
      expect(request!.method).toBe('PUT');
      expect(new URL(request!.url, endpoint).pathname).toBe(`/m100-photos/${key}`);
      expect(request!.headers.host).toBe(new URL(endpoint).host);
      expect(request!.headers['content-type']).toBe('image/jpeg');
      expect(request!.headers['content-md5']).toBeDefined();
      expect(request!.headers['x-amz-meta-sha256']).toBe(sha256(bytes));
    } finally {
      store.destroy();
    }
  });

  it('refuses bytes whose SHA-256 differs before sending anything', async () => {
    const store = new S3PhotoStore(config(endpoint));
    try {
      const bytes = jpeg('a');
      await expect(store.put(photoKey(), bytes, sha256(jpeg('b')))).rejects.toThrow(
        'does not match',
      );
      expect(seen).toEqual([]);
    } finally {
      store.destroy();
    }
  });

  it('fails a put fast when nothing listens at the endpoint', async () => {
    // A port that was just free: connections are refused.
    const closed = createServer();
    await new Promise<void>((done) => closed.listen(0, '127.0.0.1', done));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((done) => closed.close(done));

    const store = new S3PhotoStore(config(`http://127.0.0.1:${port}`));
    try {
      const started = Date.now();
      const bytes = jpeg('x');
      await expect(store.put(photoKey(), bytes, sha256(bytes))).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      store.destroy();
    }
  });
});
