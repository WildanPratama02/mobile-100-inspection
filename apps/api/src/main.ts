import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.PORT ?? 3000);
  // Only Caddy listens on the network; the API stays on loopback (doc 03 §7.1).
  await app.listen(port, '127.0.0.1');
}

void bootstrap();
