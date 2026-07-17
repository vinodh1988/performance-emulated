# Performance All-Round

Generic MongoDB all-round performance dashboard using direct MongoDB driver access.

This version does not use SSH, `mongosh`, `mongostat`, or remote shell commands. The app connects directly to MongoDB using the MongoDB Node.js driver with username/password and TLS certificate files.

## What It Can Check Through MongoDB APIs

- Replica set health: `hello`, `replSetGetStatus`
- MongoDB logs: `getLog` admin command
- Server status: `serverStatus`
- Current operations: `$currentOp`
- Profiler status and `system.profile`
- Database and collection stats: `dbStats`, `collStats`
- WiredTiger cache indicators
- Lock counters
- Replication lag
- Synthetic load generation
- Slow query comparison before and after index creation

## What It Cannot Check Without Host Access

Because this is now generic and does not SSH to the VM, it cannot read host-only files or commands such as:

- `/var/log/mongodb/mongod.log` directly
- `df -h`
- `free -m`
- `top`
- `mongostat`
- `mongotop`

Instead it uses MongoDB-native APIs like `getLog`, `serverStatus`, `dbStats`, `collStats`, and `$currentOp`.

## Linux Docker Compose Setup

Create a cert folder and place your MongoDB TLS files in it:

```bash
cd /path/to/performance-all-round
mkdir -p certs
cp /path/to/mongodb-ca.crt ./certs/mongodb-ca.crt
cp /path/to/windows-client.pem ./certs/windows-client.pem
chmod 400 ./certs/windows-client.pem
chmod 444 ./certs/mongodb-ca.crt
cp .env.example .env
nano .env
```

Example `.env`:

```env
PERF_MONGO_URI=mongodb://18.61.157.150:27017,16.112.128.67:27017,16.112.69.233:27017/admin?replicaSet=rsTraining&authSource=admin&tls=true
PERF_MONGO_USER=siteAdmin
PERF_MONGO_PASSWORD=replace-with-admin-password
PERF_AUTH_DB=admin
PERF_CERTS_DIR=./certs
PERF_TLS_CA_FILE=/certs/mongodb-ca.crt
PERF_TLS_PEM_KEY_FILE=/certs/windows-client.pem
PERF_TLS_ALLOW_INVALID_HOSTNAMES=false
PERF_LAB_DB=performance_all_round_lab
```

Start:

```bash
docker compose up --build -d
```

Open:

```text
http://localhost:3010
```

Logs:

```bash
docker compose logs -f
```

Stop:

```bash
docker compose down
```

## Local Node Run

Install dependencies once:

```bash
npm install
```

Run:

```bash
PERF_MONGO_URI='mongodb://host1:27017,host2:27017,host3:27017/admin?replicaSet=rsTraining&authSource=admin&tls=true' \
PERF_MONGO_USER='siteAdmin' \
PERF_MONGO_PASSWORD='<admin-password>' \
PERF_TLS_CA_FILE='/path/to/mongodb-ca.crt' \
PERF_TLS_PEM_KEY_FILE='/path/to/windows-client.pem' \
npm start
```

Open:

```text
http://localhost:3010
```

## Dashboard Usage

1. Fill MongoDB URI, username, password, auth DB, CA file path, client PEM path, and lab DB.
2. Click `Replica Health` first.
3. Click `Server Status`, `Current Ops`, `MongoDB Logs`, and `API Bottlenecks`.
4. Click `Generate Load` to create sample data in the lab database.
5. Click `Run Profiler Slow Query` to compare before and after index performance.

## Important

The synthetic load action drops and recreates only the configured lab database. Keep `PERF_LAB_DB=performance_all_round_lab` unless you intentionally want to target another database.
