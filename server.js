const http = require("http");
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const PORT = Number(process.env.PORT || 3010);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DOCS = path.join(ROOT, "docs");

const DEFAULT_CONFIG = {
  mongoUri: process.env.PERF_MONGO_URI || "",
  mongoUser: process.env.PERF_MONGO_USER || "",
  mongoPassword: process.env.PERF_MONGO_PASSWORD || "",
  authDb: process.env.PERF_AUTH_DB || "admin",
  tlsCAFile: process.env.PERF_TLS_CA_FILE || "/certs/mongodb-ca.crt",
  tlsPEMKeyFile: process.env.PERF_TLS_PEM_KEY_FILE || "/certs/windows-client.pem",
  tlsAllowInvalidHostnames: String(process.env.PERF_TLS_ALLOW_INVALID_HOSTNAMES || "true") === "true",
  labDb: process.env.PERF_LAB_DB || "performance_all_round_lab",
};

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(new Error("Invalid JSON body")); }
    });
  });
}

function mergeConfig(input = {}) {
  return { ...DEFAULT_CONFIG, ...input };
}

function bool(value) {
  return value === true || value === "true" || value === "on";
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function mongoOptions(config) {
  const c = mergeConfig(config);
  const options = {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 60000,
    authSource: c.authDb || "admin",
  };
  if (c.mongoUser) {
    if (!c.mongoPassword) throw new Error("MongoDB password is required in server .env.");
    options.auth = { username: c.mongoUser, password: c.mongoPassword };
  }
  if (c.tlsCAFile) options.tlsCAFile = c.tlsCAFile;
  if (c.tlsPEMKeyFile) options.tlsCertificateKeyFile = c.tlsPEMKeyFile;
  if (bool(c.tlsAllowInvalidHostnames)) options.tlsAllowInvalidHostnames = true;
  return options;
}

async function withClient(config, work) {
  const c = mergeConfig(config);
  if (!c.mongoUri) throw new Error("MongoDB URI is required.");
  const client = new MongoClient(c.mongoUri, mongoOptions(c));
  const startedAt = new Date();
  try {
    await client.connect();
    const result = await work(client, c);
    return { ok: true, startedAt, finishedAt: new Date(), result };
  } finally {
    await client.close().catch(() => {});
  }
}

function severity(level, title, detail, action) {
  return { level, title, detail, action };
}

function bytes(n) {
  if (!Number.isFinite(n)) return 0;
  return n;
}

function pct(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 1000) / 10;
}

function rate(a, b, seconds) {
  return Math.max(0, ((b || 0) - (a || 0)) / Math.max(seconds, 1));
}

function slimServerStatus(s) {
  const cache = s.wiredTiger && s.wiredTiger.cache ? s.wiredTiger.cache : {};
  return {
    host: s.host,
    version: s.version,
    process: s.process,
    uptime: s.uptime,
    connections: s.connections,
    opcounters: s.opcounters,
    mem: s.mem,
    network: s.network,
    wiredTigerCache: {
      bytesCurrentlyInCache: cache["bytes currently in the cache"] || 0,
      maxBytesConfigured: cache["maximum bytes configured"] || 0,
      trackedDirtyBytes: cache["tracked dirty bytes in the cache"] || 0,
      pagesReadIntoCache: cache["pages read into cache"] || 0,
      pagesWrittenFromCache: cache["pages written from cache"] || 0,
      evictionServerUnableToReachGoal: cache["eviction server unable to reach eviction goal"] || 0,
      operationsTimedOutWaitingForCache: cache["operations timed out waiting for space in cache"] || 0,
    },
    locks: s.locks,
  };
}

function analyzeServer(s) {
  const wt = s.wiredTigerCache || {};
  const cacheUsedPct = pct(wt.bytesCurrentlyInCache, wt.maxBytesConfigured);
  const dirtyPct = pct(wt.trackedDirtyBytes, wt.maxBytesConfigured);
  const connPct = pct(s.connections.current, s.connections.current + s.connections.available);
  const findings = [];

  findings.push(connPct > 80
    ? severity("critical", "Connection pressure is high", `${connPct}% of available connection capacity is in use.`, "Check client pooling and connection leaks.")
    : connPct > 50
      ? severity("warning", "Connection usage is moderate", `${connPct}% of connection capacity is in use.`, "Watch connection growth during load.")
      : severity("good", "Connection usage is healthy", `${connPct}% of connection capacity is in use.`, "No immediate action."));

  findings.push(cacheUsedPct > 90
    ? severity("critical", "WiredTiger cache is near full", `Cache usage is ${cacheUsedPct}%.`, "Reduce collection scans, add indexes, or scale memory.")
    : cacheUsedPct > 70
      ? severity("warning", "WiredTiger cache usage is elevated", `Cache usage is ${cacheUsedPct}%.`, "Watch eviction and pages read into cache.")
      : severity("good", "WiredTiger cache usage is normal", `Cache usage is ${cacheUsedPct}%.`, "No immediate action."));

  findings.push(dirtyPct > 20
    ? severity("warning", "Dirty cache is elevated", `Dirty cache is ${dirtyPct}% of configured cache.`, "Check write bursts, checkpoints, and disk speed.")
    : severity("good", "Dirty cache is under control", `Dirty cache is ${dirtyPct}% of configured cache.`, "No immediate action."));

  return { cacheUsedPct, dirtyPct, connPct, findings };
}

function analyzeReplication(members) {
  return members.map(m => {
    const lag = Number(m.lagSeconds || 0);
    const level = m.health !== 1 ? "critical" : lag > 30 ? "critical" : lag > 5 ? "warning" : "good";
    return {
      name: m.name,
      stateStr: m.stateStr,
      health: m.health,
      lagSeconds: lag,
      pingMs: m.pingMs,
      analysis: severity(
        level,
        level === "good" ? "Member healthy" : "Replica member needs attention",
        `${m.name} is ${m.stateStr}; lag ${lag}s; health ${m.health}.`,
        level === "good" ? "No action." : "Check network, disk, oplog application, and member load."
      )
    };
  });
}

function analyzeStorage(dbStats, collStats) {
  const collections = collStats.map(c => {
    const totalSize = bytes(c.size) + bytes(c.totalIndexSize || c.indexSize);
    const indexPct = pct(bytes(c.totalIndexSize || c.indexSize), totalSize || 1);
    const level = indexPct > 70 ? "warning" : "good";
    return {
      ns: c.ns,
      count: c.count,
      size: c.size,
      storageSize: c.storageSize,
      totalIndexSize: c.totalIndexSize || c.indexSize || 0,
      nindexes: c.nindexes,
      indexPct,
      analysis: severity(
        level,
        level === "good" ? "Collection storage looks balanced" : "Index size dominates collection footprint",
        `${c.ns}: ${c.count || 0} docs, ${c.nindexes || 0} indexes, index share ${indexPct}%.`,
        level === "good" ? "No action." : "Review unused or redundant indexes."
      )
    };
  });
  return { dbStats, collections };
}

function analyzeProfiler(entries) {
  return entries.map(e => {
    const docs = Number(e.docsExamined || 0);
    const keys = Number(e.keysExamined || 0);
    const millis = Number(e.millis || 0);
    const level = millis > 1000 || docs > 100000 ? "critical" : millis > 100 || docs > 10000 ? "warning" : "good";
    return {
      ...e,
      analysis: severity(
        level,
        level === "good" ? "Profiler entry is acceptable" : "Slow or scan-heavy operation",
        `${e.ns || "unknown"}: ${millis}ms, docsExamined ${docs}, keysExamined ${keys}, plan ${e.planSummary || "unknown"}.`,
        level === "good" ? "No action." : "Run explain, add/select better index, or reduce result set."
      )
    };
  });
}

async function getHealth(client) {
  const admin = client.db("admin");
  const hello = await admin.command({ hello: 1 });
  let replSetStatus = null;
  try { replSetStatus = await admin.command({ replSetGetStatus: 1 }); } catch (err) { replSetStatus = { error: err.message, members: [] }; }
  const primary = (replSetStatus.members || []).find(m => m.stateStr === "PRIMARY");
  const members = (replSetStatus.members || []).map(m => ({
    name: m.name,
    stateStr: m.stateStr,
    health: m.health,
    optimeDate: m.optimeDate,
    lagSeconds: primary && m.optimeDate ? (primary.optimeDate - m.optimeDate) / 1000 : 0,
    pingMs: m.pingMs,
    syncSourceHost: m.syncSourceHost || "",
  }));
  return { hello, members, replSetStatus };
}

async function getStorage(client, c) {
  const db = client.db(c.labDb);
  const dbStats = await db.command({ dbStats: 1, scale: 1024 * 1024 }).catch(err => ({ error: err.message, db: c.labDb }));
  const collections = await db.listCollections().toArray().catch(() => []);
  const collStats = [];
  for (const coll of collections.filter(x => !x.name.startsWith("system."))) {
    try { collStats.push(await db.command({ collStats: coll.name, scale: 1024 * 1024 })); } catch (err) { collStats.push({ ns: `${c.labDb}.${coll.name}`, error: err.message }); }
  }
  return analyzeStorage(dbStats, collStats);
}

async function getProfiler(client, c) {
  const db = client.db(c.labDb);
  const status = await db.command({ profile: -1 });
  const exists = await db.listCollections({ name: "system.profile" }).hasNext();
  const recent = exists ? await db.collection("system.profile").find({}, {
    projection: { ts: 1, ns: 1, op: 1, millis: 1, docsExamined: 1, keysExamined: 1, planSummary: 1, command: 1 }
  }).sort({ ts: -1 }).limit(25).toArray() : [];
  return { status, recent: analyzeProfiler(recent) };
}

async function getLogs(client) {
  const admin = client.db("admin");
  const global = await admin.command({ getLog: "global" }).catch(err => ({ error: err.message, log: [] }));
  const startupWarnings = await admin.command({ getLog: "startupWarnings" }).catch(err => ({ error: err.message, log: [] }));
  const log = global.log || [];
  const slowQueries = log.filter(line => /slow query/i.test(line)).slice(-75);
  const tlsAndAuth = log.filter(line => /SSLHandshakeFailed|authentication|authenticated|TLS/i.test(line)).slice(-75);
  const indexAndStorage = log.filter(line => /Index build|WTCHKPT|checkpoint|storage/i.test(line)).slice(-75);
  return {
    note: "MongoDB getLog returns in-memory MongoDB log lines. It is generic and does not require SSH or OS file access.",
    counts: { slowQueries: slowQueries.length, tlsAndAuth: tlsAndAuth.length, indexAndStorage: indexAndStorage.length, recent: log.slice(-100).length },
    analysis: [
      slowQueries.length ? severity("warning", "Slow query log entries found", `${slowQueries.length} recent slow query lines were found.`, "Review profiler and explain plans.") : severity("good", "No recent slow query lines found", "The in-memory log sample has no slow query lines.", "No action."),
      tlsAndAuth.length ? severity("warning", "TLS/authentication events found", `${tlsAndAuth.length} TLS/auth lines were found.`, "Check failed clients and certificate usage.") : severity("good", "No TLS/auth warnings in sample", "The in-memory log sample is clean for TLS/auth filters.", "No action."),
    ],
    slowQueries,
    tlsAndAuth,
    indexAndStorage,
    startupWarnings: startupWarnings.log || [],
    recent: log.slice(-100),
  };
}

async function getDatabaseExplorer(client, c) {
  const admin = client.db("admin");
  const dbs = await admin.command({ listDatabases: 1, nameOnly: false });
  const databaseSummaries = [];
  for (const d of dbs.databases || []) {
    if (["admin", "config", "local"].includes(d.name)) continue;
    const db = client.db(d.name);
    const collections = await db.listCollections().toArray().catch(() => []);
    const collSummaries = [];
    for (const coll of collections.filter(x => !x.name.startsWith("system."))) {
      try {
        const stats = await db.command({ collStats: coll.name, scale: 1024 * 1024 });
        const indexes = await db.collection(coll.name).indexes().catch(() => []);
        const sample = await db.collection(coll.name).find({}).limit(3).toArray().catch(() => []);
        collSummaries.push({ name: coll.name, count: stats.count, size: stats.size, storageSize: stats.storageSize, totalIndexSize: stats.totalIndexSize || stats.indexSize || 0, nindexes: stats.nindexes, indexes, sample });
      } catch (err) {
        collSummaries.push({ name: coll.name, error: err.message });
      }
    }
    databaseSummaries.push({ name: d.name, sizeOnDisk: d.sizeOnDisk, empty: d.empty, collections: collSummaries });
  }
  return { databases: databaseSummaries };
}

function mongostatRow(a, b, seconds) {
  const ac = a.opcounters || {}, bc = b.opcounters || {};
  const an = a.network || {}, bn = b.network || {};
  const aw = slimServerStatus(a).wiredTigerCache, bw = slimServerStatus(b).wiredTigerCache;
  return {
    time: new Date().toISOString(),
    insert: rate(ac.insert, bc.insert, seconds),
    query: rate(ac.query, bc.query, seconds),
    update: rate(ac.update, bc.update, seconds),
    delete: rate(ac.delete, bc.delete, seconds),
    getmore: rate(ac.getmore, bc.getmore, seconds),
    command: rate(ac.command, bc.command, seconds),
    netInKBps: Math.round(rate(an.bytesIn, bn.bytesIn, seconds) / 102.4) / 10,
    netOutKBps: Math.round(rate(an.bytesOut, bn.bytesOut, seconds) / 102.4) / 10,
    connections: b.connections.current,
    residentMB: b.mem.resident,
    virtualMB: b.mem.virtual,
    cacheUsedPct: pct(bw.bytesCurrentlyInCache, bw.maxBytesConfigured),
    dirtyPct: pct(bw.trackedDirtyBytes, bw.maxBytesConfigured),
  };
}

async function getMongostat(client, samples = 5) {
  const admin = client.db("admin");
  const rows = [];
  let prev = await admin.command({ serverStatus: 1 });
  for (let i = 0; i < samples; i++) {
    await wait(1000);
    const current = await admin.command({ serverStatus: 1 });
    rows.push(mongostatRow(prev, current, 1));
    prev = current;
  }
  return {
    source: "MongoDB serverStatus delta sampler; mongostat-compatible fields without shell access.",
    rows,
    analysis: rows.map(r => severity(
      r.cacheUsedPct > 90 || r.dirtyPct > 20 ? "warning" : "good",
      "mongostat sample",
      `cmd/s ${r.command.toFixed(1)}, query/s ${r.query.toFixed(1)}, conn ${r.connections}, cache ${r.cacheUsedPct}%, dirty ${r.dirtyPct}%.`,
      r.cacheUsedPct > 90 ? "Investigate working set, indexes, and memory." : "No immediate action."
    )),
  };
}

function topTotals(top) {
  const totals = {};
  for (const [ns, value] of Object.entries(top.totals || {})) {
    totals[ns] = {
      totalTime: value.total?.time || 0,
      readTime: value.readLock?.time || value.read?.time || 0,
      writeTime: value.writeLock?.time || value.write?.time || 0,
      totalCount: value.total?.count || 0,
      readCount: value.readLock?.count || value.read?.count || 0,
      writeCount: value.writeLock?.count || value.write?.count || 0,
    };
  }
  return totals;
}

async function getMongotop(client) {
  const admin = client.db("admin");
  const before = topTotals(await admin.command({ top: 1 }));
  await wait(1000);
  const after = topTotals(await admin.command({ top: 1 }));
  const rows = Object.keys(after).map(ns => {
    const a = before[ns] || {};
    const b = after[ns] || {};
    return {
      ns,
      totalMs: Math.max(0, (b.totalTime || 0) - (a.totalTime || 0)) / 1000,
      readMs: Math.max(0, (b.readTime || 0) - (a.readTime || 0)) / 1000,
      writeMs: Math.max(0, (b.writeTime || 0) - (a.writeTime || 0)) / 1000,
      totalOps: Math.max(0, (b.totalCount || 0) - (a.totalCount || 0)),
      readOps: Math.max(0, (b.readCount || 0) - (a.readCount || 0)),
      writeOps: Math.max(0, (b.writeCount || 0) - (a.writeCount || 0)),
    };
  }).filter(r => r.totalMs || r.totalOps).sort((a, b) => b.totalMs - a.totalMs).slice(0, 25);
  return {
    source: "MongoDB top command sampled over one second; mongotop-compatible namespace timing without shell access.",
    rows,
    analysis: rows.slice(0, 10).map(r => severity(
      r.totalMs > 100 ? "warning" : "good",
      "namespace activity",
      `${r.ns}: total ${r.totalMs.toFixed(1)}ms, read ${r.readMs.toFixed(1)}ms, write ${r.writeMs.toFixed(1)}ms over sample.`,
      r.totalMs > 100 ? "Review profiler entries for this namespace." : "No immediate action."
    )),
  };
}

const checks = {
  async health(client) {
    const h = await getHealth(client);
    return { ...h, analyzedMembers: analyzeReplication(h.members) };
  },
  async serverStatus(client) {
    const s = slimServerStatus(await client.db("admin").command({ serverStatus: 1 }));
    return { serverStatus: s, analysis: analyzeServer(s) };
  },
  async currentOps(client) {
    const ops = await client.db("admin").aggregate([
      { $currentOp: { allUsers: true, idleConnections: false } },
      { $project: { opid: 1, active: 1, secs_running: 1, op: 1, ns: 1, waitingForLock: 1, client: 1, desc: 1, command: 1 } },
      { $limit: 50 }
    ]).toArray();
    return { operations: ops, analysis: ops.map(op => severity(op.waitingForLock || Number(op.secs_running || 0) > 30 ? "warning" : "good", "operation", `${op.op || "op"} ${op.ns || ""} running ${op.secs_running || 0}s lockWait=${!!op.waitingForLock}.`, op.waitingForLock ? "Investigate blockers and locks." : "No immediate action.")) };
  },
  profiler: getProfiler,
  storage: getStorage,
  async replicationLag(client) {
    return analyzeReplication((await getHealth(client)).members);
  },
  logs: getLogs,
  async apiBottlenecks(client, c) {
    const s = slimServerStatus(await client.db("admin").command({ serverStatus: 1 }));
    const storage = await getStorage(client, c);
    return { server: s, serverAnalysis: analyzeServer(s), storage };
  },
  async mongostat(client) { return getMongostat(client, 5); },
  mongotop: getMongotop,
  databaseExplorer: getDatabaseExplorer,
};

async function getOverview(client, c) {
  const [health, serverRaw, storage, profiler, logs, mongotop] = await Promise.all([
    getHealth(client),
    client.db("admin").command({ serverStatus: 1 }).then(slimServerStatus),
    getStorage(client, c),
    getProfiler(client, c),
    getLogs(client),
    getMongotop(client),
  ]);
  const serverAnalysis = analyzeServer(serverRaw);
  const repl = analyzeReplication(health.members);
  const allFindings = [...serverAnalysis.findings, ...repl.map(r => r.analysis), ...(logs.analysis || []), ...profiler.recent.slice(0, 5).map(e => e.analysis)].filter(Boolean);
  return {
    summary: {
      setName: health.hello.setName,
      primary: health.hello.primary,
      members: health.members.length,
      host: serverRaw.host,
      version: serverRaw.version,
      currentConnections: serverRaw.connections.current,
      cacheUsedPct: serverAnalysis.cacheUsedPct,
      dirtyPct: serverAnalysis.dirtyPct,
      labDatabase: c.labDb,
      collections: storage.collections.length,
    },
    findings: allFindings,
    health: { members: repl },
    server: { serverStatus: serverRaw, analysis: serverAnalysis },
    storage,
    profiler,
    logs: { counts: logs.counts, analysis: logs.analysis },
    mongotop,
  };
}

async function createSyntheticLoad(client, c, orderCount, eventCount) {
  const db = client.db(c.labDb);
  await db.dropDatabase();

  const regions = ["HYD", "MUM", "BLR", "DEL", "CHN", "PUN"];
  const statuses = ["NEW", "PAID", "PACKED", "SHIPPED", "DELIVERED", "CANCELLED", "RETURNED"];
  const categories = ["mobile", "laptop", "tablet", "router", "camera", "speaker", "monitor", "keyboard"];
  const channels = ["web", "mobile", "store", "partner", "api"];
  const eventTypes = ["login", "search", "cart", "checkout", "payment", "support", "export"];

  async function insertBatches(collection, docs, size = 1000) {
    for (let i = 0; i < docs.length; i += size) await collection.insertMany(docs.slice(i, i + size), { ordered: false });
  }

  const customers = [];
  for (let i = 1; i <= 20000; i++) customers.push({
    customerId: "CUST" + String(i).padStart(6, "0"), region: regions[i % regions.length], city: ["Hyderabad", "Mumbai", "Bengaluru", "Delhi", "Chennai", "Pune"][i % 6], tier: ["bronze", "silver", "gold", "platinum"][i % 4], active: i % 13 !== 0, lifetimeValue: 500 + ((i * 149) % 240000), createdAt: new Date(Date.now() - (i % 900) * 86400000),
  });

  const orders = [];
  for (let i = 1; i <= orderCount; i++) orders.push({
    orderId: "ORD" + String(i).padStart(9, "0"), customerId: "CUST" + String((i % 20000) + 1).padStart(6, "0"), region: regions[i % regions.length], status: statuses[i % statuses.length], category: categories[i % categories.length], channel: channels[i % channels.length], amount: 400 + ((i * 83) % 180000), quantity: 1 + (i % 5), createdAt: new Date(Date.now() - (i % 2880) * 60000), notes: i % 19 === 0 ? "manual review slow-query candidate " + i : "normal order " + i, items: [{ sku: "SKU" + (i % 7000), qty: (i % 4) + 1 }, { sku: "SKU" + ((i + 17) % 7000), qty: (i % 3) + 1 }],
  });

  const events = [];
  for (let i = 1; i <= eventCount; i++) events.push({
    eventId: "EVT" + String(i).padStart(9, "0"), customerId: "CUST" + String((i % 20000) + 1).padStart(6, "0"), eventType: eventTypes[i % eventTypes.length], success: i % 17 !== 0, responseMs: 20 + ((i * 37) % 4000), createdAt: new Date(Date.now() - (i % 1440) * 30000), meta: { device: ["mobile", "desktop", "tablet"][i % 3], campaign: "campaign-" + (i % 80), ip: "10.40." + (i % 255) + "." + ((i * 11) % 255) },
  });

  await insertBatches(db.collection("customers"), customers);
  await insertBatches(db.collection("orders"), orders, 2500);
  await insertBatches(db.collection("events"), events, 2500);

  await db.collection("orders").createIndex({ region: 1, status: 1, amount: 1, createdAt: -1 }, { name: "idx_region_status_amount_createdAt" });
  await db.collection("orders").createIndex({ customerId: 1, createdAt: -1 }, { name: "idx_customer_createdAt" });
  await db.collection("orders").createIndex({ category: 1, notes: 1 }, { name: "idx_category_notes" });
  await db.collection("events").createIndex({ eventType: 1, responseMs: -1, createdAt: -1 }, { name: "idx_eventType_response_createdAt" });
  await db.collection("events").createIndex({ createdAt: 1 }, { name: "idx_events_createdAt_ttl", expireAfterSeconds: 604800 });
  await db.collection("customers").createIndex({ region: 1, lifetimeValue: -1 }, { name: "idx_active_customer_value", partialFilterExpression: { active: true, lifetimeValue: { $gte: 5000 } } });

  const storage = await getStorage(client, c);
  const mongostat = await getMongostat(client, 3);
  const mongotop = await getMongotop(client);
  return { database: c.labDb, counts: { customers: customers.length, orders: orders.length, events: events.length }, storage, mongostat, mongotop };
}

async function profileSlowQuery(client, c) {
  const db = client.db(c.labDb);
  const orders = db.collection("orders");
  await db.command({ profile: 1, slowms: 10, sampleRate: 1.0 });
  try { await orders.dropIndex("idx_region_status_amount_createdAt"); } catch {}
  const filter = { region: "HYD", status: "PAID", amount: { $gt: 100000 } };
  const before = await orders.find(filter).sort({ createdAt: -1 }).limit(25).explain("executionStats");
  const returnedBefore = await orders.find(filter).sort({ createdAt: -1 }).limit(25).toArray();
  await orders.createIndex({ region: 1, status: 1, amount: 1, createdAt: -1 }, { name: "idx_region_status_amount_createdAt" });
  const after = await orders.find(filter).sort({ createdAt: -1 }).limit(25).explain("executionStats");
  const returnedAfter = await orders.find(filter).sort({ createdAt: -1 }).limit(25).toArray();
  const recent = await db.collection("system.profile").find({}, { projection: { ts: 1, ns: 1, op: 1, millis: 1, docsExamined: 1, keysExamined: 1, planSummary: 1, command: 1 } }).sort({ ts: -1 }).limit(20).toArray();
  await db.command({ profile: 0 });
  return {
    filter,
    before: { winningPlan: before.queryPlanner.winningPlan, executionStats: before.executionStats, returned: returnedBefore.length },
    after: { winningPlan: after.queryPlanner.winningPlan, executionStats: after.executionStats, returned: returnedAfter.length },
    comparison: {
      docsExaminedBefore: before.executionStats.totalDocsExamined,
      docsExaminedAfter: after.executionStats.totalDocsExamined,
      keysExaminedBefore: before.executionStats.totalKeysExamined,
      keysExaminedAfter: after.executionStats.totalKeysExamined,
      timeBeforeMs: before.executionStats.executionTimeMillis,
      timeAfterMs: after.executionStats.executionTimeMillis,
    },
    analysis: severity("good", "Slow query tuned", `Docs examined moved from ${before.executionStats.totalDocsExamined} to ${after.executionStats.totalDocsExamined}; time moved from ${before.executionStats.executionTimeMillis}ms to ${after.executionStats.executionTimeMillis}ms.`, "Keep the compound index if this query shape is common."),
    profilerEntries: analyzeProfiler(recent),
  };
}

async function handleApi(req, res) {
  try {
    if (req.method === "GET" && req.url === "/api/default-config") return json(res, 200, { ...DEFAULT_CONFIG, mongoPassword: "" });

    if (req.method === "POST" && req.url === "/api/run-check") {
      const body = await readBody(req);
      const fn = checks[body.check];
      if (!fn) return json(res, 400, { error: "Unknown check" });
      const output = await withClient(body.config, fn);
      return json(res, 200, { label: body.check, ...output });
    }

    if (req.method === "POST" && req.url === "/api/dashboard/overview") {
      const body = await readBody(req);
      const output = await withClient(body.config, getOverview);
      return json(res, 200, { label: "overview", ...output });
    }

    if (req.method === "POST" && req.url === "/api/load") {
      const body = await readBody(req);
      const orderCount = Math.max(1000, Number(body.orderCount || 75000));
      const eventCount = Math.max(1000, Number(body.eventCount || 25000));
      const output = await withClient(body.config, (client, c) => createSyntheticLoad(client, c, orderCount, eventCount));
      return json(res, 200, { label: "Synthetic Load Generation", ...output });
    }

    if (req.method === "POST" && req.url === "/api/profile-slow-query") {
      const body = await readBody(req);
      const output = await withClient(body.config, profileSlowQuery);
      return json(res, 200, { label: "Profiler Slow Query Comparison", ...output });
    }

    return json(res, 404, { error: "API route not found" });
  } catch (err) {
    return json(res, 500, { ok: false, error: err.message, stack: process.env.NODE_ENV === "production" ? undefined : err.stack });
  }
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  let base = PUBLIC;
  let rel = urlPath === "/" ? "index.html" : urlPath.slice(1);
  if (urlPath.startsWith("/docs/")) { base = DOCS; rel = urlPath.slice("/docs/".length); }
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    const ext = path.extname(file).toLowerCase();
    const type = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png" }[ext] || "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) return handleApi(req, res);
  return serveStatic(req, res);
});

server.listen(PORT, () => console.log(`performance-all-round dashboard running at http://localhost:${PORT}`));

