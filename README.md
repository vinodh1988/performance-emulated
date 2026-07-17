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
