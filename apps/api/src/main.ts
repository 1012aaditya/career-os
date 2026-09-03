import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  console.log(`[startup] DATABASE_URL present: ${Boolean(process.env.DATABASE_URL)}`);

  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
