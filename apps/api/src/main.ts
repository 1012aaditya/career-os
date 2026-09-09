import { ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  DocumentBuilder,
  SwaggerModule,
} from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import {
  corsAllowedOrigins,
  currentEnvironment,
  shouldServeApiDocs,
} from './environment.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  /*
   * Security headers, from a maintained implementation rather than a
   * hand-written list that goes stale.
   *
   * Most of what helmet sets is aimed at browsers rendering HTML, and this
   * is a JSON API consumed by a native iOS client - so the defaults are
   * narrowed to what is actually meaningful here rather than applied
   * wholesale:
   *
   *   contentSecurityPolicy: OFF. A CSP governs what a DOCUMENT may load,
   *   and this API returns no documents - except Swagger, which needs
   *   inline scripts and styles and which a default CSP would simply
   *   break. Enabling a policy that only ever fires on the one HTML page
   *   we serve, in order to break it, is theatre.
   *
   *   crossOriginEmbedderPolicy: OFF. It constrains what a document may
   *   embed. Same reason.
   *
   * What is left is the set that matters for an API:
   *
   *   X-Content-Type-Options: nosniff - a JSON error body must never be
   *   re-interpreted as HTML or script by a browser that went looking.
   *
   *   Referrer-Policy: no-referrer - the strongest setting, and the one
   *   Phase 7 already chose by hand for the OAuth callback because a
   *   referrer header is how an authorization code leaves the building.
   *   Applying it everywhere makes that a property of the API rather than
   *   of one route somebody remembered.
   *
   *   X-Frame-Options / frameguard: deny - nothing here is meant to be
   *   framed, and Swagger in an iframe on somebody else's page is a
   *   clickjacking surface for no benefit.
   *
   *   Strict-Transport-Security - only meaningful over HTTPS, harmless
   *   over HTTP, and it must be present the first time a real browser
   *   ever reaches production rather than added afterwards.
   *
   *   X-Powered-By is removed, which is free.
   */
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'no-referrer' },
      frameguard: { action: 'deny' },
    }),
  );

  /*
   * CORS, deny-by-default.
   *
   * The only client today is a native iOS app, which is not a browser and
   * is not subject to CORS - so the correct allowlist is empty, and an
   * empty allowlist means no cross-origin browser request is answered.
   * That is a deliberate position rather than an unfinished one: allowing
   * an origin now would mean inventing a web frontend that does not exist.
   *
   * `origin: '*'` is not reachable from configuration. A wildcard in
   * CORS_ALLOWED_ORIGINS is filtered out, because '*' with credentials is
   * precisely the misconfiguration this exists to prevent.
   */
  const allowedOrigins = corsAllowedOrigins();

  app.enableCors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : false,
    credentials: allowedOrigins.length > 0,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  });

  /*
   * API documentation, off in production by default.
   *
   * It was mounted unconditionally, which published the complete route
   * surface - every parameter, every shape - to anyone who asked. Nothing
   * here is a secret on its own, and publishing all of it to the public
   * internet is still a gift to somebody mapping the API.
   *
   * Not "never in production": API_DOCS_ENABLED can turn it on, so the
   * decision exists as a value somebody set rather than as a default
   * nobody chose. The document itself carries no examples and no secrets -
   * it is generated from the DTOs.
   */
  if (shouldServeApiDocs()) {
    const config = new DocumentBuilder()
      .setTitle('Career Capital OS API')
      .setDescription('API for Career Capital OS')
      .setVersion('1.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, config);

    SwaggerModule.setup('docs', app, document);
  }

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
   */
  app.enableShutdownHooks();

  await app.listen(process.env.PORT ?? 3000);

  /*
   * One line, naming what is on and what is off. No URL, no credential,
   * no configuration value - just the two decisions an operator most
   * needs to be able to confirm from a log they are already reading.
   */
  process.stdout.write(
    `[startup] environment=${currentEnvironment()} docs=${shouldServeApiDocs() ? 'on' : 'off'} cors-origins=${allowedOrigins.length}\n`,
  );
}

await bootstrap();
