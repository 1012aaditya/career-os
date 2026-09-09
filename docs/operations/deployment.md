# Deployment

What PR-6 built, what it measured, and what it could not reach.

Read the status labels literally. **Verified** means a command produced the
stated result on this machine. **Written, unapplied** means the artefact
exists and is committed but has never run against real infrastructure.
**Blocked** means it needs an account or credential that does not exist
here. Nothing in this document is inferred from a vendor's documentation
and presented as fact.

---

## Environments

| | Local | Staging | Production |
|---|---|---|---|
| API | `pnpm dev` | not created | not created |
| Database | local Postgres 17 | not created | not created |
| Region | laptop | — | **US East** (required, see below) |
| Status | Verified | Blocked | Blocked |

The existing hosted Supabase project in Sydney is **development**, and PR-6
does not retire it. It must not become production: it is in the wrong
region for the reason measured below, and it holds development data under
credentials that predate any of this work.

**Blocked:** creating the staging and production Supabase projects. The
Supabase management token available here reaches an organisation that
contains no Career OS project — the Career OS project lives under a
different account. Everything below that depends on a production project is
therefore designed and committed but unapplied.

---

## Why production must be in US East

This is the single most consequential number PR-6 produced, so it is stated
before the deployment mechanics rather than after.

PR-4 saw `P2028 — Unable to start a transaction in the given time` against
the Sydney pooler, twice in five attempts, while the same code passed 9/9
locally. PR-6 reproduced it deterministically by putting a
latency-injecting TCP proxy in front of a **local** Postgres, holding
schema, query shape, pool configuration and Prisma version identical so
that round-trip time was the only variable.

Forty concurrent import transactions, distinct users, so nothing contends
on a row lock:

| RTT | pool | succeeded | P2028 | median |
|---|---|---|---|---|
| 0 ms | 10 | 40 | 0 | 94 ms |
| 250 ms | 10 | 11 | 29 | 2008 ms |
| 250 ms | 20 | 21 | 19 | 2004 ms |
| 250 ms | 40 | 40 | 0 | 1890 ms |

Read rows two and three together: **the number that succeeds tracks the
pool size, not the load.** An import transaction is six round trips —
`BEGIN`, the row lock, two counts, the insert, `COMMIT` — so at 250 ms it
*holds* a connection for about 1.9 s against a 2 s `maxWait`. One pool's
worth starts; everything behind it waits longer than the budget and fails
before doing any work.

So P2028 is not a timeout that is too small. It is hold time that is
twenty times too long, and hold time here is a function of **distance**.

Two other fixes were measured and rejected:

- **Raising `maxWait` to 15 s.** 21 of 40 still failed, but the failures
  moved from a fast, precisely-named `P2028` to a generic error at a 10 s
  median and a 20 s maximum. That is the same failure, slower and harder to
  diagnose.
- **Enlarging the pool.** It helps only when transactions do not contend.
  Under the contention this transaction exists for — several imports by one
  user, serialised on that user's row lock — a pool of 40 was *worse* than a
  pool of 10, at a 21 s median, because a larger pool only lets more
  requests hold a connection while blocked on the lock.

Hence: co-locate, and leave the budget alone. `DATABASE_TRANSACTION_MAX_WAIT_MS`
and `DATABASE_TRANSACTION_TIMEOUT_MS` now exist and default to Prisma's own
values, unchanged — they are a knob for an operator, not a fix.

**Verified:** the measurements above, and that migrations apply cleanly to
an empty database producing a schema identical to development (45 tables,
21 enums, 65 foreign keys, 7 CHECK constraints, 146 indexes, 11
migrations).

**Not verified:** that P2028 disappears against a real US-East Supabase
project. That requires the project. The evidence says it will; the evidence
is a local proxy, not production.

---

## Connection pool

Configured on the node-postgres pool in `src/prisma/prisma.service.ts`, not
in the URL — under the Prisma driver adapter, `?connection_limit=` is
silently ignored.

`DATABASE_POOL_MAX = 10`, **per process**. What the database sees is:

```
instances x DATABASE_POOL_MAX  +  worker  +  any running migration
```

At two API instances that is 20 + worker + migration ≈ 25 connections, which
must stay under the Supabase pooler's own client limit — a limit shared
with the worker, and one this deployment has not been able to read.

10 is measured rather than inherited: co-located, a pool of 10 served 40
concurrent distinct-user transactions with a 94 ms median and no failures.
Raise it only after reading the pooler's actual ceiling, and never to
compensate for latency — that was measured and made things worse.

---

## Deploying the API

**Written, unapplied.** `render.yaml` at the repository root and
`apps/api/Dockerfile`.

- **Image**: multi-stage, built from the repository root because the pnpm
  lockfile lives there. Runs as the unprivileged `node` user. **Verified**
  that the image builds; see the defects found below.
- **Start command**: `node dist/main`, deliberately not `pnpm start:prod`.
  A package manager in between swallows `SIGTERM`, so Nest's shutdown hooks
  never fire, the pool is never closed, and every deploy leaks connections.
- **Health check**: `/v1/health/ready`, which returns 503 when the database
  is unreachable. Not `/v1/health/live`, which has no dependencies by
  design and answers 200 from a process that cannot reach Postgres at all.
- **`trust proxy`**: `TRUSTED_PROXY_HOPS=1` behind Render's edge. Not
  `true`. The rate limiter keys on `req.ip`, which Express derives from a
  client-supplied `X-Forwarded-For`; trusting the whole chain lets any
  caller choose their own source address and hold an unlimited budget.
  The default is 0.

### Three defects found by actually building and running the image

None of these are visible from reading the code. Each would have broken or
silently degraded the first production deploy.

**1. `dotenv` was declared nowhere.** `prisma.config.ts` imports
`dotenv/config`, and it resolved on a developer machine only because pnpm
happened to hoist it. Any clean or filtered install failed at `prisma
generate`. Now declared. The Prisma CLI moved from dev to production
dependencies for the same reason: the release step runs `prisma migrate
deploy` inside the runtime image.

**2. The container ignored SIGTERM entirely.** `docker stop` waited the
full grace period and then SIGKILLed - exit 137, even at a 40 second
timeout - while the same build stopped in 2 seconds on the host.

The cause is PID 1: the kernel does not apply default signal dispositions
to it, so SIGTERM was discarded and Nest's shutdown hooks never ran. The
consequence is precisely what PR-2 added those hooks to prevent - every
deploy abandoning in-flight requests and leaving the database pool open for
the server to reap, on a pooler whose capacity is shared with the worker.
PR-2's work was intact, and the container was quietly cancelling it.

Fixed with `tini` as the image entrypoint. Measured after: stops in under a
second, exit 143. `docker run --init` does the same thing, but Render does
not pass it, so it belongs in the image.

**3. `prisma migrate deploy` failed inside the image.** `schema.prisma`
declares only a provider - the connection URL comes from `prisma.config.ts`
reading `DATABASE_URL` - and that file was not copied into the runtime
stage. The release command failed with "The datasource.url property is
required", *after* the image had been built and was about to take traffic.
Now copied.

The general lesson is the one PR-6 exists for: a build that has only ever
run on a laptop has not been tested.

## Migrations

`preDeployCommand: npx prisma migrate deploy` — after the image is built,
before the new instance takes traffic, and **never at application startup**.

Startup migration means every instance in a scaled service races to run the
same DDL, and a failed migration becomes a crash loop instead of a halted
deploy. `migrate deploy` applies committed migrations in order and refuses
to generate one; it is the only migration command that should see
production.

**Rollback.** Prisma has no `migrate down`, and pretending otherwise is how
a bad deploy becomes a bad afternoon:

- **Additive migration** (new table, new nullable column, new index):
  roll back the *application* image. The schema is forward-compatible and
  can stay.
- **Destructive migration** (dropped or renamed column, narrowed type,
  new NOT NULL): not reversible by redeploying. Recovery is restore-from-
  backup into a new database and repoint, which is the procedure in
  `backup-and-recovery.md` and costs whatever the RPO is. Write the
  compensating migration *before* deploying the destructive one.

The 11 committed migrations were reviewed: none drops a table or a column.

---

## Rate limiting across instances

**Verified.** The counter moved from a per-process `Map` into Redis
(`src/throttling/redis-throttler.storage.ts`), incremented by an atomic Lua
script that sets the key's expiry in the same step — so every key is
bounded by construction and there is nothing to sweep.

Tested against a real Redis: three storage instances round-robin one
caller and see `1,2,3,4,5,6,7`; two per-process stores see `1,1`. Breaking
the shared namespace fails four tests, so the test is not vacuous.

**When Redis is unreachable** the limiter degrades to the per-process
counter — not open, not closed. Failing closed turns a Redis incident into
a total outage; failing open makes knocking Redis over step one of any
attack on the routes the limiter protects. Degrading keeps a real bound,
just a weaker one, and is the behaviour the system had before Redis
existed. Verified by a test against a dead port.

With `REDIS_URL` unset the behaviour is exactly PR-2's, which is correct
for one process.

---

## Log shipping and alerting

**Blocked.** Both need a destination account that does not exist here.

PR-5's logs are structured JSON on stdout with an allowlist — a shipper
reads stdout regardless of vendor, so no code change is needed to collect
them. What must not change is the allowlist: the destination must never
receive a field that PR-5 excluded, and adding raw request or response
logging to "make the logs useful" would undo it.

Alerts worth having, with the condition and the action, so this is a
specification rather than a wish:

| Alert | Condition | Action |
|---|---|---|
| Readiness failing | `/v1/health/ready` non-2xx on all instances for 2 min | Database or pooler down. Check Supabase status, then connection count. |
| Sustained 5xx | 5xx rate > 5% over 5 min | Read `errorCategory` on the failing requests; `database` and `dependency` point in different directions. |
| P2028 returning | `errorCode = P2028` more than 5 times in 10 min | Co-location has regressed or the pooler is saturated. Do not raise `maxWait`. |
| Throttle store down | `event = throttle.store.unavailable` sustained | Limits are per-instance until Redis returns. Not urgent; not ignorable. |
| Backup failed | storage backup exit code non-zero | Resume files are unprotected until it succeeds. |

Deliberately excluded: alerting on 4xx. Those are the system working.

---

## What is not done

Everything below needs an account, credential or plan that is not
reachable from this machine. None of it has been faked.

- Staging and production Supabase projects, in US East.
- Generated production credentials. Every production secret must be
  generated, not copied from development — including the database password,
  the worker secret and the token encryption keys. `.env.example` documents
  the variable names and the generation commands; it contains no values.
- Production auth configuration: site URL, redirect URLs, and a production
  GitHub OAuth callback. The mobile redirect must exactly match what the
  app parses or users finish authorisation and land on a dead link.
- Applying `render.yaml`, and with it: the deployed API, the deployed
  worker, the production smoke test, and health checks through a real proxy.
- Log shipping, retention and alerting.
- The `career-files` bucket decision — private, but with no size or MIME
  limit and no application code referencing it. It needs inspection in a
  real project before being constrained or removed.
- Production performance measurement. The numbers in this document are from
  a local proxy, and are evidence, not production telemetry.
