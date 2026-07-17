# MongoDB Performance All-Round Command List

Replace `<admin-password>` before running commands manually.

## SSH to Primary

```powershell
ssh -i D:\mongo.pem -o StrictHostKeyChecking=no ubuntu@18.61.157.150
```

## TLS mongosh

```bash
sudo mongosh \
  --tls \
  --tlsCAFile /etc/mongodb/ssl/mongodb-ca.crt \
  --tlsCertificateKeyFile /etc/mongodb/ssl/windows-client.pem \
  --host 127.0.0.1 \
  --port 27017 \
  -u siteAdmin \
  -p '<admin-password>' \
  --authenticationDatabase admin
```

## Replica Health

```javascript
db.hello()
rs.status()
rs.printReplicationInfo()
rs.printSecondaryReplicationInfo()
```

## Logs

```bash
sudo tail -n 120 /var/log/mongodb/mongod.log
sudo grep -i "slow query" /var/log/mongodb/mongod.log | tail -n 40
sudo grep -i "SSLHandshakeFailed\|authentication\|Successfully authenticated" /var/log/mongodb/mongod.log | tail -n 40
sudo grep -i "Index build\|WTCHKPT\|error\|exception" /var/log/mongodb/mongod.log | tail -n 40
```

## Server Status

```javascript
const s = db.serverStatus()
printjson({
  connections: s.connections,
  opcounters: s.opcounters,
  mem: s.mem,
  wiredTigerCache: s.wiredTiger.cache,
  locks: s.locks
})
```

## Current Operations

```javascript
db.getSiblingDB("admin").aggregate([
  { $currentOp: { allUsers: true, idleConnections: false } },
  { $project: { opid: 1, active: 1, secs_running: 1, op: 1, ns: 1, waitingForLock: 1, client: 1 } },
  { $limit: 20 }
])
```

## OS Memory, Disk, CPU

```bash
free -m
df -h
top -b -n 1 | head -n 25
```

## mongostat

```bash
sudo mongostat \
  --host 127.0.0.1 \
  --port 27017 \
  --username siteAdmin \
  --password '<admin-password>' \
  --authenticationDatabase admin \
  --ssl \
  --sslCAFile /etc/mongodb/ssl/mongodb-ca.crt \
  --sslPEMKeyFile /etc/mongodb/ssl/windows-client.pem \
  --rowcount 5 1
```

## mongotop

```bash
sudo mongotop \
  --host 127.0.0.1 \
  --port 27017 \
  --username siteAdmin \
  --password '<admin-password>' \
  --authenticationDatabase admin \
  --ssl \
  --sslCAFile /etc/mongodb/ssl/mongodb-ca.crt \
  --sslPEMKeyFile /etc/mongodb/ssl/windows-client.pem \
  1 --rowcount 5
```

## Profiler

```javascript
use performance_all_round_lab
db.setProfilingLevel(1, { slowms: 10, sampleRate: 1.0 })
db.system.profile.find({}, { ts: 1, ns: 1, millis: 1, docsExamined: 1, keysExamined: 1, planSummary: 1 }).sort({ ts: -1 }).limit(10)
db.setProfilingLevel(0)
```

## Slow Query Comparison

```javascript
const filter = { region: "HYD", status: "PAID", amount: { $gt: 100000 } }
db.orders.find(filter).sort({ createdAt: -1 }).limit(25).explain("executionStats")
db.orders.createIndex({ region: 1, status: 1, amount: 1, createdAt: -1 }, { name: "idx_region_status_amount_createdAt" })
db.orders.find(filter).sort({ createdAt: -1 }).limit(25).explain("executionStats")
```
