# Production PostgreSQL runbook

SendAm supports a managed PostgreSQL service such as Neon through
`DATABASE_URL`, or a self-hosted PostgreSQL 16 instance provisioned by
`docker-compose.production.yml`. A managed service with automated point-in-time
recovery, multi-zone availability, TLS, and provider monitoring is preferred.

## Configuration

The API receives one secret:

```text
DATABASE_URL=postgresql://USER:PASSWORD@HOST/sendam?sslmode=require
```

Production connections to non-local hosts must set `sslmode=require`,
`verify-ca`, or `verify-full`. Use separate least-privilege runtime and migration
roles when the provider supports them: the migration role owns the schema, while
the runtime role receives only the CRUD permissions required by the API. Never
commit either URL.

For self-hosting, copy `deploy/postgres.env.example` to a root-level `.env`,
replace the password with a long random secret, restrict the file to the
deployment user, and run:

```bash
docker compose --env-file .env -f docker-compose.production.yml config
docker compose --env-file .env -f docker-compose.production.yml up -d postgres
docker compose --env-file .env -f docker-compose.production.yml ps
```

The production Compose definition does not publish PostgreSQL to the host. The
API must share the private `sendam-production_database` network or connect
through a separately secured private endpoint. The named data and backup
volumes must be included in host backup policy.

## Rollout

1. Provision the database, enable provider backups/PITR, and record the restore
   procedure and retention period.
2. Take a pre-migration snapshot of an existing installation.
3. Run `npm ci` and `npm run prisma:generate --workspace=apps/api`.
4. From a trusted migration runner with `DATABASE_URL`, run
   `npm run db:provision --workspace=apps/api`. This applies forward-only Prisma
   migrations and then checks connectivity, migration history, failed or pending
   migrations, PostgreSQL version, and required tables.
   Alternatively, configure `PRODUCTION_DATABASE_URL` in the protected GitHub
   `production` environment and manually run the **Provision production
   database** workflow with the required confirmation phrase. The workflow is
   serialized so two production migrations cannot run concurrently.
5. Deploy the API only after the validator emits
   `{"event":"database_validation_passed",...}`.
6. Exercise `/health` and a read/write smoke test, then watch database and API
   telemetry for at least one normal traffic window.

CI independently applies the migrations to an empty PostgreSQL 16 database and
to a simulated existing installation containing a sentinel user. It verifies
the sentinel survives the forward migration and verifies that an unreachable
database is rejected.

## Monitoring

Alert on:

- API `/health` reporting `db: disconnected`;
- `database_validation_failed` from release jobs;
- PostgreSQL availability, storage above 80%, connection use above 80% of
  `max_connections`, replication lag, backup failure, and sustained slow-query
  volume;
- any unfinished or rolled-back row in `_prisma_migrations`.

The self-hosted definition logs connections and statements slower than one
second by default. Send PostgreSQL container logs and API health checks to the
production log/alert platform. Platform Engineering owns provisioning,
credentials, backups, migrations, and recovery; application owners approve
schema changes and validate application behavior.

## Rollback and recovery

Prisma production migrations are forward-only. Do not run `migrate reset`,
`db push`, or manually delete `_prisma_migrations` rows in production.

If application deployment fails but the migration succeeds, roll back the
application image while leaving additive schema changes in place. For an
incompatible migration, stop writers, restore the pre-migration snapshot into a
new database, run `db:validate` against it, switch `DATABASE_URL`, and then
resume traffic. Never overwrite the failed database until reconciliation is
complete.

If a migration is interrupted, stop the release and application writers,
inspect PostgreSQL and `_prisma_migrations`, take a snapshot, and follow
Prisma's `migrate resolve` procedure only after identifying whether the SQL was
applied. Re-run `db:provision` and application smoke tests before reopening
traffic.

Test restores regularly: provision an isolated PostgreSQL instance from the
latest backup, run `db:provision`, run `db:validate`, and verify representative
user and transaction counts against the source.
