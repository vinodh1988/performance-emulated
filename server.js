const http = require("http");
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const PORT = Number(process.env.PORT || 3010);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DOCS = path.join(ROOT, "docs");

const DEFAULT_CONFIG = {
  mongoUri: process.env.PERF_MONGO_URI || "mongodb://18.61.157.150:27017,16.112.128.67:27017,16.112.69.233:27017/admin?replicaSet=rsTraining&authSource=admin&tls=true",
  mongoUser: process.env.PERF_MONGO_USER || "siteAdmin",
  mongoPassword: process.env.PERF_MONGO_PASSWORD || "",
  authDb: process.env.PERF_AUTH_DB || "admin",
  tlsCAFile: process.env.PERF_TLS_CA_FILE || "/certs/mongodb-ca.crt",
  tlsPEMKeyFile: process.env.PERF_TLS_PEM_KEY_FILE || "/certs/windows-client.pem",
  tlsAllowInvalidHostnames: String(process.env.PERF_TLS_ALLOW_INVALID_HOSTNAMES || "false") === "true",
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

function mongoOptions(config) {
  const c = mergeConfig(config);
  const options = {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 60000,
    authSource: c.authDb || "admin",
  };
  if (c.mongoUser) {
    if (!c.mongoPassword) throw new Error("MongoDB password is required.");
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

function slimServerStatus(s) {
  return {
    host: s.host,
    version: s.version,
    process: s.process,
    uptime: s.uptime,
    connections: s.connections,
    opcounters: s.opcounters,
    mem: s.mem,
    network: s.network,
    wiredTigerCache: s.wiredTiger && s.wiredTiger.cache ? {
      bytesCurrentlyInCache: s.wiredTiger.cache["bytes currently in the cache"],
      maxBytesConfigured: s.wiredTiger.cache["maximum bytes configured"],
      trackedDirtyBytes: s.wiredTiger.cache["tracked dirty bytes in the cache"],
      pagesReadIntoCache: s.wiredTiger.cache["pages read into cache"],
      pagesWrittenFromCache: s.wiredTiger.cache["pages written from cache"],
      evictionServerUnableToReachGoal: s.wiredTiger.cache["eviction server unable to reach eviction goal"],
      operationsTimedOutWaitingForCache: s.wiredTiger.cache["operations timed out waiting for space in cache"],
    } : null,
    locks: s.locks,
  };
}

const checks = {
  async health(client) {
    const admin = client.db("admin");
    const hello = await admin.command({ hello: 1 });
    let replSetStatus = null;
    try { replSetStatus = await admin.command({ replSetGetStatus: 1 }); } catch (err) { replSetStatus = { error: err.message }; }
    return { hello, members: replSetStatus.members || [], replSetStatus };
  },

  async serverStatus(client) {
    return slimServerStatus(await client.db("admin").command({ serverStatus: 1 }));
  },

  async currentOps(client) {
    return client.db("admin").aggregate([
      { $currentOp: { allUsers: true, idleConnections: false } },
      { $project: { opid: 1, active: 1, secs_running: 1, op: 1, ns: 1, waitingForLock: 1, client: 1, desc: 1, command: 1 } },
      { $limit: 30 }
    ]).toArray();
  },

  async profiler(client, c) {
    const db = client.db(c.labDb);
    const status = await db.command({ profile: -1 });
    const exists = await db.listCollections({ name: "system.profile" }).hasNext();
    const recent = exists ? await db.collection("system.profile").find({}, {
      projection: { ts: 1, ns: 1, op: 1, millis: 1, docsExamined: 1, keysExamined: 1, planSummary: 1, command: 1 }
    }).sort({ ts: -1 }).limit(10).toArray() : [];
    return { status, recent };
  },

  async storage(client, c) {
    const db = client.db(c.labDb);
    const dbStats = await db.command({ dbStats: 1, scale: 1024 * 1024 });
    const collections = await db.listCollections().toArray();
    const collStats = [];
    for (const coll of collections.filter(x => !x.name.startsWith("system."))) {
      try { collStats.push(await db.command({ collStats: coll.name, scale: 1024 * 1024 })); } catch (err) { collStats.push({ ns: coll.name, error: err.message }); }
    }
    return { dbStats, collStats };
  },

  async replicationLag(client) {
    const status = await client.db("admin").command({ replSetGetStatus: 1 });
    const primary = status.members.find(m => m.stateStr === "PRIMARY");
    return status.members.map(m => ({
      name: m.name,
      stateStr: m.stateStr,
      health: m.health,
      optimeDate: m.optimeDate,
      lagSeconds: primary && m.optimeDate ? (primary.optimeDate - m.optimeDate) / 1000 : 0,
      pingMs: m.pingMs,
      syncSourceHost: m.syncSourceHost || "",
    }));
  },

  async logs(client) {
    const admin = client.db("admin");
    const global = await admin.command({ getLog: "global" }).catch(err => ({ error: err.message, log: [] }));
    const startupWarnings = await admin.command({ getLog: "startupWarnings" }).catch(err => ({ error: err.message, log: [] }));
    const log = global.log || [];
    return {
      note: "MongoDB getLog returns in-memory MongoDB log lines. It is generic and does not require SSH or OS file access.",
      slowQueries: log.filter(line => /slow query/i.test(line)).slice(-50),
      tlsAndAuth: log.filter(line => /SSLHandshakeFailed|authentication|authenticated|TLS/i.test(line)).slice(-50),
      indexAndStorage: log.filter(line => /Index build|WTCHKPT|checkpoint|storage/i.test(line)).slice(-50),
      startupWarnings: startupWarnings.log || [],
      recent: log.slice(-100),
    };
  },

  async apiBottlenecks(client, c) {
    const admin = client.db("admin");
    const db = client.db(c.labDb);
    const s = await admin.command({ serverStatus: 1 });
    const dbStats = await db.command({ dbStats: 1, scale: 1024 * 1024 }).catch(err => ({ error: err.message }));
    return {
      note: "Direct MongoDB mode cannot read host df/free/top. These are MongoDB API level memory, cache, storage, and lock indicators.",
      memory: s.mem,
      wiredTigerCache: slimServerStatus(s).wiredTigerCache,
      locks: s.locks,
      connections: s.connections,
      opcounters: s.opcounters,
      dbStats,
    };
  },
};

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
    customerId: "CUST" + String(i).padStart(6, "0"),
    region: regions[i % regions.length],
    city: ["Hyderabad", "Mumbai", "Bengaluru", "Delhi", "Chennai", "Pune"][i % 6],
    tier: ["bronze", "silver", "gold", "platinum"][i % 4],
    active: i % 13 !== 0,
    lifetimeValue: 500 + ((i * 149) % 240000),
    createdAt: new Date(Date.now() - (i % 900) * 86400000),
  });

  const orders = [];
  for (let i = 1; i <= orderCount; i++) orders.push({
    orderId: "ORD" + String(i).padStart(9, "0"),
    customerId: "CUST" + String((i % 20000) + 1).padStart(6, "0"),
    region: regions[i % regions.length],
    status: statuses[i % statuses.length],
    category: categories[i % categories.length],
    channel: channels[i % channels.length],
    amount: 400 + ((i * 83) % 180000),
    quantity: 1 + (i % 5),
    createdAt: new Date(Date.now() - (i % 2880) * 60000),
    notes: i % 19 === 0 ? "manual review slow-query candidate " + i : "normal order " + i,
    items: [{ sku: "SKU" + (i % 7000), qty: (i % 4) + 1 }, { sku: "SKU" + ((i + 17) % 7000), qty: (i % 3) + 1 }],
  });

  const events = [];
  for (let i = 1; i <= eventCount; i++) events.push({
    eventId: "EVT" + String(i).padStart(9, "0"),
    customerId: "CUST" + String((i % 20000) + 1).padStart(6, "0"),
    eventType: eventTypes[i % eventTypes.length],
    success: i % 17 !== 0,
    responseMs: 20 + ((i * 37) % 4000),
    createdAt: new Date(Date.now() - (i % 1440) * 30000),
    meta: { device: ["mobile", "desktop", "tablet"][i % 3], campaign: "campaign-" + (i % 80), ip: "10.40." + (i % 255) + "." + ((i * 11) % 255) },
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

  return {
    database: c.labDb,
    customers: await db.collection("customers").countDocuments(),
    orders: await db.collection("orders").countDocuments(),
    events: await db.collection("events").countDocuments(),
    indexes: {
      customers: await db.collection("customers").indexes(),
      orders: await db.collection("orders").indexes(),
      events: await db.collection("events").indexes(),
    },
    dbStats: await db.command({ dbStats: 1, scale: 1024 * 1024 }),
  };
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
  const recent = await db.collection("system.profile").find({}, { projection: { ts: 1, ns: 1, op: 1, millis: 1, docsExamined: 1, keysExamined: 1, planSummary: 1, command: 1 } }).sort({ ts: -1 }).limit(10).toArray();
  await db.command({ profile: 0 });
  return {
    filter,
    before: { winningPlan: before.queryPlanner.winningPlan, executionStats: before.executionStats, returned: returnedBefore.length },
    after: { winningPlan: after.queryPlanner.winningPlan, executionStats: after.executionStats, returned: returnedAfter.length },
    profilerEntries: recent,
  };
}

async function handleApi(req, res) {
  try {
    if (req.method === "GET" && req.url === "/api/default-config") {
      return json(res, 200, { ...DEFAULT_CONFIG, mongoPassword: "" });
    }

    if (req.method === "POST" && req.url === "/api/run-check") {
      const body = await readBody(req);
      const fn = checks[body.check];
      if (!fn) return json(res, 400, { error: "Unknown check" });
      const output = await withClient(body.config, fn);
      return json(res, 200, { label: body.check, ...output });
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
  if (urlPath.startsWith("/docs/")) {
    base = DOCS;
    rel = urlPath.slice("/docs/".length);
  }
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
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
