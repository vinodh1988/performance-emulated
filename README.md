# Performance All-Round

MongoDB all-round performance dashboard and tutorial for a TLS-enabled replica set.

The dashboard runs commands over SSH on the MongoDB primary and executes MongoDB tools locally on that server. It does not store the MongoDB password in source code.

## Run Locally

```powershell
cd D:\new-projects\mongodb-course\performance-all-round
$env:PERF_SSH_KEY="D:\mongo.pem"
$env:PERF_SSH_HOST="18.61.157.150"
$env:PERF_MONGO_PASSWORD="<admin-password>"
npm start
```

Open:

```text
http://localhost:3010
```

## Run with Docker

From the project folder:

```powershell
docker build -t performance-all-round .
docker run --rm -p 3010:3010 `
  -v D:\mongo.pem:/keys/mongo.pem:ro `
  -e PERF_SSH_KEY=/keys/mongo.pem `
  -e PERF_SSH_HOST=18.61.157.150 `
  -e PERF_MONGO_PASSWORD="<admin-password>" `
  performance-all-round
```

Open:

```text
http://localhost:3010
```

## Dashboard Functions

- Replica set health and lag
- MongoDB log analysis
- `serverStatus`
- `$currentOp`
- Database profiler recent entries
- Storage and collection stats
- OS memory, disk, and CPU checks
- `mongostat`
- `mongotop`
- Synthetic load generation
- Slow query profiling and index comparison

## Documentation

Full tutorial:

```text
docs/tutorial.html
```

Command list:

```text
scripts/commands.md
```

## Run with Docker Compose

Create your local `.env` from the sample and set the real password:

```powershell
cd D:\new-projects\mongodb-course\performance-all-round
Copy-Item .env.example .env
notepad .env
```

Start:

```powershell
docker compose up --build -d
```

Open:

```text
http://localhost:3010
```

Check logs:

```powershell
docker compose logs -f
```

Stop:

```powershell
docker compose down
```

## Linux Deployment Notes

When moving this project to Linux, place the EC2 key file in the project root:

```bash
cd /path/to/performance-all-round
cp /path/to/mongo.pem ./mongo.pem
chmod 400 ./mongo.pem
cp .env.example .env
nano .env
```

Use these Linux-friendly values in `.env`:

```env
PERF_SSH_USER=ubuntu
PERF_SSH_HOST=18.61.157.150
PERF_LOCAL_SSH_KEY=./mongo.pem
PERF_MONGO_HOST=127.0.0.1
PERF_MONGO_PORT=27017
PERF_MONGO_USER=siteAdmin
PERF_MONGO_PASSWORD=replace-with-admin-password
PERF_AUTH_DB=admin
PERF_TLS_CA_FILE=/etc/mongodb/ssl/mongodb-ca.crt
PERF_TLS_PEM_KEY_FILE=/etc/mongodb/ssl/windows-client.pem
PERF_LAB_DB=performance_all_round_lab
```

Start with Compose:

```bash
docker compose up --build -d
```

Open:

```text
http://localhost:3010
```

The compose file mounts `./mongo.pem` into the container as `/keys/mongo.pem:ro`, and the app uses `/keys/mongo.pem` for SSH.

## PEM Permission Handling Inside Docker

The host key is mounted read-only at `/keys/mongo.pem`. The container entrypoint copies it to `/app/.ssh/mongo.pem`, runs `chmod 400 /app/.ssh/mongo.pem`, and sets the app to use that private copy.

This avoids SSH errors such as:

```text
WARNING: UNPROTECTED PRIVATE KEY FILE!
Permissions 0644 for 'mongo.pem' are too open.
```

The Compose variables are:

```env
PERF_LOCAL_SSH_KEY=./mongo.pem
PERF_SSH_KEY_SOURCE=/keys/mongo.pem
PERF_SSH_KEY=/app/.ssh/mongo.pem
```

You still should keep the host file restricted:

```bash
chmod 400 ./mongo.pem
```
