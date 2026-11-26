# Health Fieldnote

[简体中文](README.zh-CN.md)

Health Fieldnote is a personal journal for meals, training, weight, body fat, and daily activity. Run it on Unraid or locally, and use the dot API to log measurements, attach photos to meals, and query your history from another client.

## Features

- Log meals and calorie estimates. Save meals as drafts and choose whether a day's intake comes from its meal entries or an explicit daily total.
- Record weight, body fat percentage, and waist circumference together or separately. View daily readings and trends.
- Store private meal and progress photos in the self-hosted SQLite database.
- Import Nothing X ZIP and XLSX exports with workout details and daily activity snapshots. The importer skips GPS routes, heart rate, stress, and account information.
- Receive Health Data Export Raw JSON webhooks with Bearer authentication. Import weight, body fat, workouts, and daily activity with persistent deduplication and protection for manual edits. See the [setup and merge rules](deploy/HEALTH-DATA-EXPORT.md).
- Use the browser locally or connect it to the same self-hosted database as dot. The OpenAI Sites build supports the browser journal and D1 storage.

## Quick start

Install Node.js 24 and npm, then run these commands from the repository root.

```sh
npm ci
npm run dev
```

Open the address printed by Vite. The development server supports browser-local storage and sample data. To try the dot API, start the self-hosted server below.

### Run the self-hosted server locally

```sh
npm ci
npm run build
mkdir -p -m 700 .fieldnote.local
if [ ! -e .fieldnote.local/password ]; then
  (umask 077; openssl rand -hex 32 > .fieldnote.local/password)
fi
FIELDNOTE_ORIGIN=http://127.0.0.1:8080 \
FIELDNOTE_BIND=127.0.0.1 \
FIELDNOTE_DB="$PWD/.fieldnote.local/health.sqlite" \
FIELDNOTE_PASSWORD_FILE="$PWD/.fieldnote.local/password" \
node selfhost/server.js
```

Open `http://127.0.0.1:8080`. Sign in as `fieldnote` with the password from `.fieldnote.local/password`. HTTP is restricted to loopback. Use HTTPS for Unraid or any other network deployment.

### Deploy on Unraid

Use the [single-container HTTPS guide](deploy/UNRAID-SINGLE.md). For an existing Caddy setup, see the [two-container guide](deploy/UNRAID.md). Preserve the mounted `/data` directory when replacing a container. The server migrates the previous SQLite schema on startup. Take a snapshot before upgrading so you can roll back with the previous image and its database.

Build this checkout locally with Docker if the published image predates the API implementation.

```sh
docker build --platform linux/amd64 -t health-fieldnote:local .
```

| Setting | Purpose |
| --- | --- |
| `FIELDNOTE_ORIGIN` | Public HTTPS origin, including a non-default port. Local HTTP requires `127.0.0.1` binding. |
| `FIELDNOTE_PASSWORD_FILE` | Browser and legacy API password file. Default `/run/secrets/fieldnote_password`. |
| `FIELDNOTE_DB` | SQLite path. Default `/data/health.sqlite`. |
| `FIELDNOTE_TLS_DIR` | Directory containing `server.crt` and `server.key` for direct HTTPS. |
| `FIELDNOTE_BIND`, `PORT` | Listen address and port. Defaults to `0.0.0.0` and port `8443` with direct TLS or `8080` without it. |
| `FIELDNOTE_MEDIA_QUOTA_BYTES` | Maximum stored image bytes per owner. Default 5 GB. |

## Connect dot

Create a personal access token on the same instance that serves the API. The following command runs inside an Unraid container named `fieldnote`.

```sh
docker exec fieldnote node selfhost/token.js create dot
```

For the loopback server, use its database directly from a second terminal.

```sh
FIELDNOTE_DB="$PWD/.fieldnote.local/health.sqlite" node selfhost/token.js create dot
```

The command prints the token once. Store it in dot's credential store. The default scopes cover reading and writing records and images. To grant deletion as well, pass `records:read,records:write,records:delete,media:read,media:write,media:delete` as the final argument. Run `node selfhost/token.js list` to find token IDs and `node selfhost/token.js revoke <token-id>` to revoke a token. To rotate, create the replacement with the same client ID before revoking the old token.

Set `FIELDNOTE_API` to the deployment's API root and `FIELDNOTE_TOKEN` from your credential store. Supply your trusted deployment CA to the HTTP client when using a local CA.

```sh
export FIELDNOTE_API='http://127.0.0.1:8080/api/v1'
curl --fail-with-body -H "Authorization: Bearer $FIELDNOTE_TOKEN" "$FIELDNOTE_API/capabilities"
```

Example measurement write. Use a fresh idempotency key and external ID for each new measurement. Reuse the same values when retrying the same write.

```sh
curl --fail-with-body "$FIELDNOTE_API/measurements" \
  -H "Authorization: Bearer $FIELDNOTE_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'X-Fieldnote: 1' \
  -H 'Idempotency-Key: example-startup-20261125-measurement' \
  --data '{"date":"2026-11-25","weightKg":70.25,"bodyFatPct":21.5,"source":{"client":"dot","externalId":"example:measurement:20261125"}}'

curl --fail-with-body -H "Authorization: Bearer $FIELDNOTE_TOKEN" \
  "$FIELDNOTE_API/trends?metric=bodyFatPct&from=2026-11-19&to=2026-11-25"
```

The [OpenAPI contract](docs/api/openapi.json) describes all 37 operations. The [API guide](docs/api/DOT-API-DESIGN.md) explains intake rules, image uploads, error responses, and how to use ETags for edits. `/api/v1` is available on the self-hosted server. Nothing X uploads use the existing [Basic-auth import endpoint](deploy/IMPORT-API.md).

## Back up your data

```sh
docker exec fieldnote node selfhost/backup.js
```

The command writes a consistent database snapshot under `/data/backups`, including image blobs. Keep a separate copy and protect it as you would the live database. To restore, stop the container and restore the snapshot to the configured SQLite path with permissions for UID 1000. Remove obsolete WAL/SHM files from the old database before restarting. The browser JSON export covers the browser journal projection and excludes image files and API-only metadata.

## Develop and contribute

```sh
npm ci
npm run build
npm test
```

Tests use Node's SQLite module, OpenSSL, and local loopback ports. The HTTP integration suite validates every dot operation against OpenAPI and exercises legacy migration, Nothing X import, and backup restore. The Docker build runs the suite on Linux before assembling the runtime image.

Open an issue to report a problem or propose a change. Include reproduction steps and synthetic fixtures. For API changes, update the OpenAPI contract and add coverage for compatibility or behavior changes. Keep personal health records, photos, credentials, and SQLite files out of issues and pull requests.

## License

This repository currently has no `LICENSE` file. Contact the maintainer for licensing terms.
