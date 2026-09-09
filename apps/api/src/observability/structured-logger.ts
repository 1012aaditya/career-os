import { Injectable, Logger } from '@nestjs/common';

import { currentEnvironment, logPseudonymSalt } from '../environment.js';
import { currentRequestId } from './request-context.js';
import {
  describeError,
  pseudonymize,
  safeFields,
  type LogFields,
  type SafeErrorShape,
} from './log-fields.js';

/*
 * The one way this API writes a log line.
 *
 * NO NEW DEPENDENCY, deliberately. Nest ships a Logger, three Phase 7
 * services already use it, and a log aggregator reads stdout regardless of
 * which library produced it. Adding pino or winston would buy formatting
 * we can write in twenty lines and cost a dependency on the path where
 * secrets travel. What was missing was never a library - it was a
 * discipline about WHAT goes in a line, and that lives in log-fields.ts.
 *
 * THE SHAPE OF THE API IS THE CONTROL. There is no `log(message, object)`
 * here. A caller names an EVENT - a short stable code - and passes fields
 * that are filtered against an allowlist. There is no way to hand this an
 * error, a request or a session and have it serialised, because no method
 * accepts one: `describeError` reduces a throwable to a class and a code
 * before it can reach a line.
 *
 * PRODUCTION EMITS JSON, one object per line, because that is what a log
 * aggregator can index. Development emits the same fields through Nest's
 * pretty logger, because a human is reading them.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

@Injectable()
export class StructuredLogger {
  private readonly nest = new Logger('api');

  private readonly environment = currentEnvironment();

  private readonly salt = logPseudonymSalt();

  /**
   * A stable, non-reversible stand-in for a user id, for the `actor` field.
   *
   * The reason this is a method on the logger rather than something call
   * sites do themselves: a caller that has to remember to hash is a caller
   * who will one day pass the raw id, and the allowlist cannot tell the
   * difference between a pseudonym and an id - they are both strings in an
   * allowed field.
   */
  actor(userId: string): string {
    return pseudonymize(userId, this.salt);
  }

  /**
   * Records that something happened.
   *
   * `event` is a short stable code - `http.request`, `db.readiness.failed`
   * - and not a sentence. Codes are greppable, translatable into alerts,
   * and cannot accidentally contain an interpolated user value, which is
   * exactly how PII reaches a log in a system that formats messages.
   */
  event(level: LogLevel, event: string, fields: Record<string, unknown> = {}) {
    const safe = safeFields({ ...fields, event });

    this.emit(level, {
      ...safe,
      service: 'career-os-api',
      environment: this.environment,
      /*
       * Read here rather than passed in, so a caller deep in a service
       * cannot forget it and cannot pass somebody else's.
       */
      requestId: safe.requestId ?? currentRequestId(),
    });
  }

  /**
   * Records a failure, with the error reduced to its safe shape first.
   *
   * The only method that takes a throwable, and it never stores one: the
   * value is converted to a class, a code and a category, and the original
   * is dropped. That is what keeps a Prisma connection error - which
   * carries the connection string in its message - out of the log.
   */
  failure(
    event: string,
    error: unknown,
    fields: Record<string, unknown> = {},
  ): SafeErrorShape {
    const shape = describeError(error);

    this.event('error', event, { ...fields, ...shape });

    return shape;
  }

  private emit(level: LogLevel, fields: LogFields & Record<string, unknown>) {
    /*
     * Undefined keys are dropped so a line carries only what is known.
     * JSON.stringify would omit them anyway; doing it here keeps the
     * development output equally clean.
     */
    const line: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        line[key] = value;
      }
    }

    if (this.environment === 'production' || this.environment === 'staging') {
      /*
       * One JSON object per line, straight to stdout. Not through Nest's
       * logger: that one prefixes a timestamp, a pid and a context in
       * human format, which would make each line invalid JSON and defeat
       * the aggregator this format exists for.
       */
      process.stdout.write(
        `${JSON.stringify({ level, timestamp: new Date().toISOString(), ...line })}\n`,
      );

      return;
    }

    /*
     * Development and test. The same fields, through Nest so they line up
     * with the framework's own output and with the three Phase 7 services
     * that already log this way.
     */
    const rendered = JSON.stringify(line);

    switch (level) {
      case 'error':
        this.nest.error(rendered);
        break;
      case 'warn':
        this.nest.warn(rendered);
        break;
      case 'debug':
        this.nest.debug(rendered);
        break;
      default:
        this.nest.log(rendered);
    }
  }
}
