# Running locally on Windows

Use Node.js 22 and pnpm 10.33.0. Run the commands below from the repository root in PowerShell.

## Configuration

Install dependencies with `pnpm install`. The API reads `apps/api/.env`, not the root `.env`.
Use `.env.example` as a reference. Keep local credentials out of Git.

Use `NODE_ENV=development`, a `DATABASE_URL` and `MIGRATE_DATABASE_URL` for `m100_dev`,
`TZ=Asia/Jakarta`, a development photo directory, and an existing `JWT_KEY_FILE` containing
at least 32 random bytes. PostgreSQL must be running and the configured database credentials must work.

On a PostgreSQL server shared with production, use a separate runtime login such as
`m100_dev_app`, with direct grants for the API's runtime operations only in `m100_dev`.
Do not make it a member of the production runtime role. A PostgreSQL administrator should
create the login, grant it `CONNECT` on `m100_dev`, apply the runtime grants from
`db/migrations/0005_grants.sql` to that login inside `m100_dev`, and verify it cannot connect
to the production database. Configure it as:

```dotenv
DATABASE_URL=postgresql://m100_dev_app:URL_ENCODED_PASSWORD@127.0.0.1:5432/m100_dev
```

Use the actual generated password, URL-encoded when it contains special characters.
Updating `.env` does not change the password stored in PostgreSQL. Keep
`MIGRATE_DATABASE_URL` on the separate migration role; the runtime login cannot run migrations.
Restart the API after changing its environment.

Set `PORT=3100` in `apps/api/.env` if port 3000 is already occupied.
Both frontend terminals below explicitly target this port.

## Start the applications

Terminal 1, API with automatic rebuilds:

```powershell
cd D:\Project\mobile-100-inspection
pnpm --filter api start:dev
```

Terminal 2, tablet web app:

```powershell
cd D:\Project\mobile-100-inspection
$env:M100_API_URL = 'http://127.0.0.1:3100'
pnpm dev
```

Open `http://localhost:5173`.

Terminal 3, optional admin app:

```powershell
cd D:\Project\mobile-100-inspection
$env:M100_API_URL = 'http://127.0.0.1:3100'
pnpm dev:admin
```

Open `http://localhost:5175/admin/`. Restart a frontend after changing its proxy environment.
Stop each server with Ctrl+C. `pnpm --filter api start` runs the existing build;
use `pnpm --filter api build` first when running without watch mode.

## Verify and troubleshoot

```powershell
Invoke-RestMethod http://127.0.0.1:3100/v1/health
Get-NetTCPConnection -LocalPort 3000 -State Listen |
  Select-Object LocalAddress, LocalPort, OwningProcess
```

`EADDRINUSE` means another process already owns the requested port. Use the existing API
or select a free port and point both frontend proxies to it. Check the process identity before stopping it.

The health endpoint checks liveness only. A `password authentication failed for user "m100_app"`
startup warning means the database credentials also need correction in `apps/api/.env`.
Do not reset shared PostgreSQL role passwords casually: the bootstrap command updates
cluster-wide roles and can affect other databases using them.

For a new, isolated development PostgreSQL server, configure its development credentials, then run
`pnpm db:bootstrap`, `pnpm db:migrate`, and `pnpm import-master --dir <export-folder>`.
Existing databases do not need bootstrapping on every startup.

A new browser profile needs a registered device key. Run `pnpm device:add --label "Local development browser"`
against the development database, then open `http://localhost:5173/setup#k=<key>` using the printed key.
Keep the key private. If the printed setup URL uses the deployment host, use the localhost URL above.
An optional development admin can be created with `pnpm admin:create --dev-default`;
this requires `NODE_ENV=development` and the development database.

An existing browser registration remains valid after changing the API port or database password.
Register again only if the browser has no valid stored key or the connected database has no
active registration for that key. Production device registrations do not carry over to a
separate development database.
