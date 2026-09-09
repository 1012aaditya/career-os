import { ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  DocumentBuilder,
  SwaggerModule,
} from '@nestjs/swagger';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const config = new DocumentBuilder()
    .setTitle('Career Capital OS API')
    .setDescription('API for Career Capital OS')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup('docs', app, document);

  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  /*
   * Graceful shutdown.
   *
   * Nest does not listen for SIGTERM unless asked, and without this the
   * process died on every deploy with its database pool still open and any
   * in-flight request abandoned mid-write. PrismaService has always had an
   * onModuleDestroy that disconnects; nothing ever called it.
   *
   * What this buys, in order: Nest stops accepting new connections, lets
   * in-flight handlers finish, then runs onModuleDestroy down the module
   * graph - which closes the pool. On a shared pooler that last step is
   * not just tidiness: connections we do not close are held until the
   * server's own timeout reaps them, and that capacity is shared with the
   * worker and with migrations.
   *
   * The startup console.log that used to sit here is gone. It printed only
   * a boolean, so it leaked nothing, but it was left over from a debugging
   * session and structured logging is PR-5's job rather than a print
   * statement's.
   */
  app.enableShutdownHooks();

  await app.listen(process.env.PORT ?? 3000);
}

await bootstrap();
