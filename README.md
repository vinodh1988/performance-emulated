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
Instead of shelling out for `mongostat` and `mongotop`, this app now provides MongoDB-native equivalents:

- mongostat page: repeated `serverStatus` samples and delta calculations
- mongotop page: MongoDB `top` command sampled by namespace

It also uses MongoDB-native APIs like `getLog`, `serverStatus`, `dbStats`, `collStats`, `$currentOp`, profiler data, and `replSetGetStatus`.

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
PERF_MONGO_URI=mongodb://172.31.4.11:27017,172.31.10.231:27017,172.31.15.9:27017/admin?replicaSet=rsTraining&authSource=admin&tls=true
PERF_MONGO_USER=siteAdmin
PERF_MONGO_PASSWORD=replace-with-admin-password
PERF_AUTH_DB=admin
PERF_CA_FILE=/home/ubuntu/mongodb-ca.crt
PERF_CLIENT_PEM_FILE=/home/ubuntu/windows-client.pem
PERF_TLS_CA_FILE=/certs/mongodb-ca.crt
PERF_TLS_PEM_KEY_FILE=/certs/windows-client.pem
PERF_TLS_ALLOW_INVALID_HOSTNAMES=true
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

## Fixed Hyderabad VM Deployment

For the target Linux VM where the replica set primary also runs, the compose setup expects:

```text
/home/ubuntu/mongodb-ca.crt
/home/ubuntu/windows-client.pem
```

The remote `.env` used for deployment is created with:

```env
PERF_MONGO_URI=mongodb://172.31.4.11:27017,172.31.10.231:27017,172.31.15.9:27017/admin?replicaSet=rsTraining&authSource=admin&tls=true
PERF_MONGO_USER=siteAdmin
PERF_MONGO_PASSWORD=<configured-on-remote-vm>
PERF_AUTH_DB=admin
PERF_CA_FILE=/home/ubuntu/mongodb-ca.crt
PERF_CLIENT_PEM_FILE=/home/ubuntu/windows-client.pem
PERF_TLS_CA_FILE=/certs/mongodb-ca.crt
PERF_TLS_PEM_KEY_FILE=/certs/windows-client.pem
PERF_TLS_ALLOW_INVALID_HOSTNAMES=true
PERF_LAB_DB=performance_all_round_lab
```

Do not commit the real password. Keep it only in the remote `.env` file.


## Super Analyzer Pages

The dashboard is now split into clear pages:

- Overview: top health cards, findings, replication lag, namespace activity, collection footprint
- Replica Set: member state, health, lag, sync source, and meaning
- Server: connections, op counters, cache, memory, network, and lock interpretation
- Memory: WiredTiger cache and dirty cache analyzer
- Storage: database stats, collection stats, index size, storage size, and meaning
- Profiler: recent `system.profile` entries with slow-query interpretation
- Logs: MongoDB `getLog` slow query, TLS/auth, index, storage, and startup warning analysis
- mongostat: serverStatus delta sampler with mongostat-style rates and graphs
- mongotop: MongoDB `top` command sampler with namespace read/write timing and graphs
- Collections: database/collection explorer with counts, indexes, sizes, and sample docs
- Custom Load: synthetic workload generation followed by storage, mongostat, and mongotop analysis

`mongostat` and `mongotop` are implemented without SSH by using MongoDB-native APIs:

- mongostat page = repeated `serverStatus` samples and delta calculations
- mongotop page = `top` admin command sampled by namespace

This keeps the app generic and still shows how the cluster responds to custom load.


### Lab database installation

On container startup the app checks `PERF_LAB_DB` and automatically creates the lab database when the expected `customers`, `orders`, and `events` collections are missing.

Default install size:

```env
PERF_AUTO_INSTALL_LAB=true
PERF_INSTALL_ORDERS=10000
PERF_INSTALL_EVENTS=5000
```

Manual install from the server:

```bash
curl -X POST http://localhost:3010/api/install-lab \
  -H "Content-Type: application/json" \
  -d '{"orderCount":10000,"eventCount":5000,"config":{}}'
```

Manual install from the UI:

```text
Custom Load -> Install Lab DB
```

Use `Custom Load -> Run Load and Analyze` when you want to recreate the lab database with a larger workload.
