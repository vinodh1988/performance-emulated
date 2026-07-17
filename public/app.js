const content = document.getElementById("content");
const title = document.getElementById("pageTitle");
const subtitle = document.getElementById("pageSubtitle");
const navs = [...document.querySelectorAll(".nav")];
let currentPage = "overview";
let lastResults = {};
let livePollTimer = null;


const pageDetails = {
  overview: {
    command: `POST /api/dashboard/overview
Backend calls executed in parallel:
1. db.adminCommand({ hello: 1 })
2. db.adminCommand({ replSetGetStatus: 1 })
3. db.adminCommand({ serverStatus: 1 })
4. db.getSiblingDB(PERF_LAB_DB).runCommand({ dbStats: 1, scale: 1024 * 1024 })
5. db.getSiblingDB(PERF_LAB_DB).listCollections()
6. db.getSiblingDB(PERF_LAB_DB).runCommand({ collStats: "<collection>", scale: 1024 * 1024 })
7. db.getSiblingDB(PERF_LAB_DB).runCommand({ profile: -1 })
8. db.getSiblingDB(PERF_LAB_DB).system.profile.find(...).sort({ ts: -1 }).limit(25)
9. db.adminCommand({ getLog: "global" })
10. db.adminCommand({ getLog: "startupWarnings" })
11. db.adminCommand({ top: 1 }), wait 1 second, db.adminCommand({ top: 1 })`,
    props: [
      ["setName", "Replica set name returned by hello."],
      ["primary", "Current writable primary member from hello/replSetGetStatus."],
      ["currentConnections", "Open MongoDB client connections from serverStatus.connections.current."],
      ["cacheUsedPct", "bytes currently in WiredTiger cache divided by maximum bytes configured."],
      ["dirtyPct", "tracked dirty cache bytes divided by maximum bytes configured."],
      ["findings", "Combined findings from server, replication, logs, and profiler rules."],
    ],
    conditions: [
      ["Server", "connection > 80% critical, > 50% warning; cache > 90% critical, > 70% warning; dirty cache > 20% warning."],
      ["Replication", "member health != 1 critical; lag > 30s critical; lag > 5s warning."],
      ["Storage", "index footprint > 70% of collection data+index footprint warning."],
      ["Profiler", "millis > 1000 or docsExamined > 100000 critical; millis > 100 or docsExamined > 10000 warning."],
      ["Logs", "slow query and TLS/auth lines create good/warning findings; storage/index/checkpoint lines are counted and shown for context."],
    ],
  },
  replica: {
    command: `POST /api/run-check { check: "health" }
Backend commands:
db.adminCommand({ hello: 1 })
db.adminCommand({ replSetGetStatus: 1 })`,
    props: [
      ["stateStr", "Replica member role such as PRIMARY, SECONDARY, STARTUP2, RECOVERING, or ARBITER."],
      ["health", "1 means reachable/healthy from the current node; 0 means unreachable/unhealthy."],
      ["optimeDate", "Latest operation timestamp applied by the member."],
      ["lagSeconds", "Primary optimeDate minus member optimeDate, calculated in seconds."],
      ["pingMs", "Heartbeat latency to the member in milliseconds."],
      ["syncSourceHost", "Member from which this secondary is currently syncing."],
    ],
    conditions: [
      ["Critical", "health != 1 or lagSeconds > 30."],
      ["Warning", "lagSeconds > 5 and <= 30."],
      ["Good", "health == 1 and lagSeconds <= 5."],
    ],
  },
  server: {
    command: `POST /api/run-check { check: "serverStatus" }
Backend command:
db.adminCommand({ serverStatus: 1 })
The app then keeps host, version, process, uptime, connections, opcounters, mem, network, wiredTiger.cache, and locks.`,
    props: [
      ["connections.current", "Current open client connections."],
      ["connections.available", "Remaining connection capacity."],
      ["opcounters", "Cumulative insert/query/update/delete/getmore/command counters since process start."],
      ["mem.resident", "Approximate mongod resident memory in MB."],
      ["network.numRequests", "Total network requests handled by mongod."],
      ["wiredTigerCache", "Selected WiredTiger cache fields normalized by the backend."],
    ],
    conditions: [
      ["Connection pressure", "current / (current + available): > 80% critical, > 50% warning, otherwise good."],
      ["Cache usage", "bytesCurrentlyInCache / maxBytesConfigured: > 90% critical, > 70% warning, otherwise good."],
      ["Dirty cache", "trackedDirtyBytes / maxBytesConfigured: > 20% warning, otherwise good."],
    ],
  },
  memory: {
    command: `POST /api/run-check { check: "serverStatus" }
Backend command:
db.adminCommand({ serverStatus: 1 })
Fields read:
serverStatus.mem
serverStatus.wiredTiger.cache`,
    props: [
      ["bytesCurrentlyInCache", "Current bytes held in WiredTiger cache."],
      ["maxBytesConfigured", "Configured WiredTiger cache maximum."],
      ["trackedDirtyBytes", "Dirty bytes waiting to be written/checkpointed."],
      ["pagesReadIntoCache", "Pages read from disk into cache. Fast growth can mean working set misses."],
      ["pagesWrittenFromCache", "Pages written from cache to disk."],
      ["evictionServerUnableToReachGoal", "Eviction pressure signal. Non-zero growth deserves attention."],
    ],
    conditions: [
      ["Cache pressure", "same rule as Server: cache > 90% critical, > 70% warning."],
      ["Dirty cache", "tracked dirty cache > 20% warning."],
      ["Eviction clues", "eviction and pages-read fields are shown for interpretation; current rule does not mark severity from them directly."],
    ],
  },
  storage: {
    command: `POST /api/run-check { check: "storage" }
Backend commands:
db.getSiblingDB(PERF_LAB_DB).runCommand({ dbStats: 1, scale: 1024 * 1024 })
db.getSiblingDB(PERF_LAB_DB).listCollections()
db.getSiblingDB(PERF_LAB_DB).runCommand({ collStats: "<collection>", scale: 1024 * 1024 })`,
    props: [
      ["objects", "Total documents in the database."],
      ["dataSize", "Logical uncompressed data size in MB."],
      ["storageSize", "Allocated physical collection storage in MB."],
      ["totalIndexSize", "Storage used by indexes for a collection."],
      ["nindexes", "Number of indexes on the collection."],
      ["indexPct", "totalIndexSize / (collection size + totalIndexSize)."],
    ],
    conditions: [
      ["Warning", "indexPct > 70%. The app flags that indexes dominate the collection footprint."],
      ["Good", "indexPct <= 70%. Storage is treated as balanced."],
    ],
  },
  profiler: {
    command: `POST /api/run-check { check: "profiler" }
Backend commands:
db.getSiblingDB(PERF_LAB_DB).runCommand({ profile: -1 })
db.getSiblingDB(PERF_LAB_DB).system.profile.find({}, {
  projection: { ts, ns, op, millis, docsExamined, keysExamined, planSummary, command }
}).sort({ ts: -1 }).limit(25)`,
    props: [
      ["millis", "Operation execution time in milliseconds."],
      ["docsExamined", "Documents scanned by the operation."],
      ["keysExamined", "Index keys scanned."],
      ["planSummary", "Short winning plan summary such as COLLSCAN or IXSCAN."],
      ["ns", "Namespace: database.collection affected by the operation."],
      ["command", "Original command/query shape captured by profiler."],
    ],
    conditions: [
      ["Critical", "millis > 1000 OR docsExamined > 100000."],
      ["Warning", "millis > 100 OR docsExamined > 10000."],
      ["Good", "below warning thresholds."],
    ],
  },
  logs: {
    command: `POST /api/run-check { check: "logs" }
Backend commands:
db.adminCommand({ getLog: "global" })
db.adminCommand({ getLog: "startupWarnings" })
Backend filters global log lines with regexes for slow query, TLS/auth, and storage/index/checkpoint signals.`,
    props: [
      ["slowQueries", "Log lines containing slow query messages."],
      ["tlsAndAuth", "TLS, SSL, authentication, authorization, login, and SASL related log lines."],
      ["indexAndStorage", "Index build, checkpoint, WiredTiger, and storage-related log lines."],
      ["startupWarnings", "Warnings emitted during MongoDB startup."],
      ["recent", "Most recent in-memory global log lines returned by getLog."],
    ],
    conditions: [
      ["Slow query finding", "warning if one or more slow query lines are found; good if none are found."],
      ["TLS/auth finding", "warning/info finding when matching TLS/auth lines exist."],
      ["Storage/index lines", "matching storage/index/checkpoint lines are counted and displayed, but they do not currently change severity."],
    ],
  },
  mongostat: {
    command: `POST /api/run-check { check: "mongostat" }
Backend sampler:
Sample A: db.adminCommand({ serverStatus: 1 })
wait 1 second
Sample B: db.adminCommand({ serverStatus: 1 })
Repeat 5 times
rate = (B counter - A counter) / seconds`,
    props: [
      ["insert/query/update/delete", "Per-second operation rates calculated from opcounters deltas."],
      ["getmore", "Cursor getMore operations per second."],
      ["command", "MongoDB command operations per second."],
      ["netInKBps / netOutKBps", "Network throughput calculated from serverStatus network byte deltas."],
      ["cacheUsedPct", "WiredTiger cache usage percentage at sample time."],
      ["dirtyPct", "Dirty cache percentage at sample time."],
    ],
    conditions: [
      ["Warning", "cacheUsedPct > 90 OR dirtyPct > 20."],
      ["Good", "cacheUsedPct <= 90 AND dirtyPct <= 20."],
      ["Rates", "operation and network rates are deltas between consecutive serverStatus samples."],
    ],
  },
  mongotop: {
    command: `POST /api/run-check { check: "mongotop" }
Backend sampler:
Sample A: db.adminCommand({ top: 1 })
wait 1 second
Sample B: db.adminCommand({ top: 1 })
namespace time = B namespace counters - A namespace counters
Rows are sorted by totalMs and limited to top 25.`,
    props: [
      ["ns", "Namespace measured by MongoDB top command."],
      ["totalMs", "Total time spent on that namespace during the sample."],
      ["readMs", "Read-lock/read time during the sample."],
      ["writeMs", "Write-lock/write time during the sample."],
      ["totalOps", "Operations observed on the namespace during the sample."],
      ["readOps/writeOps", "Read and write operation counts in the sample window."],
    ],
    conditions: [
      ["Warning", "totalMs > 100 for a namespace in the one-second sample."],
      ["Good", "totalMs <= 100."],
      ["Scope", "analysis is created for the top 10 displayed namespaces."],
    ],
  },
  databaseExplorer: {
    command: `POST /api/run-check { check: "databaseExplorer" }
Backend commands:
db.adminCommand({ listDatabases: 1, nameOnly: false })
For each database except admin, config, and local:
db.listCollections({}, { nameOnly: true })
db.runCommand({ collStats: "<collection>", scale: 1024 * 1024 })
db.collection.getIndexes()
db.collection.find({}).limit(3)`,
    props: [
      ["sizeOnDisk", "Database size on disk reported by listDatabases."],
      ["collections", "Non-system collections discovered in each inspected database."],
      ["count", "Document count from collStats."],
      ["indexes", "Index definitions returned by getIndexes."],
      ["sample", "First three documents shown for shape inspection."],
    ],
    conditions: [
      ["Database filter", "admin, config, and local databases are skipped."],
      ["Collection filter", "collections whose names start with system. are skipped."],
      ["Sample", "only first 3 documents per collection are returned."],
    ],
  },
  load: {
    command: `Custom load workflow:
POST /api/install-lab, POST /api/load, POST /api/live-load/start, GET /api/live-load/status, POST /api/live-load/stop
Backend steps:
1. db.getSiblingDB(PERF_LAB_DB).dropDatabase()
2. insertMany(customers)
3. insertMany(orders)
4. insertMany(events)
5. createIndex(...) on orders, events, and customers
6. collect storage using dbStats/collStats
7. collect mongostat using serverStatus samples
8. collect mongotop using top samples
9. live mode repeats inserts, reads, updates, serverStatus sampling, and top sampling until stop is pressed`,
    props: [
      ["customers/orders/events", "Synthetic documents created for the lab workload."],
      ["storage", "dbStats and collStats immediately after load."],
      ["mongostat", "serverStatus delta samples collected after load."],
      ["mongotop", "top namespace timing collected after load."],
    ],
    conditions: [
      ["Install Lab DB", "creates default 20,000 customers, 10,000 orders, and 5,000 events only when required collections are missing."],
      ["Run Load", "recreates the lab database with selected order/event counts; customers remain 20,000."],
      ["Indexes", "creates compound, TTL, and partial indexes used by the dashboard labs."],
      ["Live Load", "runs continuously in server memory, appending mongostat rows and replacing mongotop rows every sample until Stop Live Load is pressed."],
    ],
  },
};
const pageMeta = {
  overview: ["Overview", "Cluster health, bottleneck summary, and top findings."],
  replica: ["Replica Set", "Member health, roles, optime, and lag."],
  server: ["Server Performance", "Connections, operation counters, network, locks, and process metrics."],
  memory: ["Memory / WiredTiger", "Cache usage, dirty cache, eviction signals, and resident memory."],
  storage: ["Storage / Collections", "Database size, collection size, index size, and storage interpretation."],
  profiler: ["Slow Query / Profiler", "Recent profiler entries and query tuning meaning."],
  logs: ["Logs Analyzer", "MongoDB getLog slow query, TLS, auth, storage, and warning signals."],
  mongostat: ["mongostat", "MongoDB serverStatus delta samples shown like mongostat."],
  mongotop: ["mongotop", "MongoDB top command sampled by namespace like mongotop."],
  databaseExplorer: ["Database Collections", "Databases, collections, indexes, sizes, counts, and samples."],
  load: ["Custom Load Test", "Generate workload and immediately inspect impact."],
};

const pageCheckMap = {
  replica: "health",
  server: "serverStatus",
  memory: "serverStatus",
};

function config() { return {}; }
function fmt(n) { return Number.isFinite(Number(n)) ? Number(n).toLocaleString() : "-"; }
function mb(n) { return Number.isFinite(Number(n)) ? `${Number(n).toFixed(2)} MB` : "-"; }
function pct(n) { return `${Number(n || 0).toFixed(1)}%`; }
function esc(v) { return String(v ?? "").replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }

async function post(url, body = {}) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data.result ?? data;
}

async function getLiveLoadStatus() {
  const res = await fetch("/api/live-load/status");
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data.result ?? data;
}

async function startLiveLoad(batchSize) {
  return post("/api/live-load/start", { batchSize, config: config() });
}

async function stopLiveLoad() {
  return post("/api/live-load/stop", { config: config() });
}
async function check(name) { return post("/api/run-check", { check: name, config: config() }); }
async function overview() { return post("/api/dashboard/overview", { config: config() }); }

function commandPanel(page) {
  const detail = pageDetails[page];
  if (!detail) return "";
  const conditionTable = detail.conditions ? `<section class="panel glossary-panel"><h2>Analysis Conditions</h2>${table(["Rule", "Condition Used"], detail.conditions.map(([p, m]) => `<tr><td><code>${esc(p)}</code></td><td>${esc(m)}</td></tr>`))}</section>` : "";
  return `<section class="explain-stack"><section class="grid two explain-grid"><section class="panel command-panel"><h2>Command Used</h2><pre>${esc(detail.command)}</pre></section><section class="panel glossary-panel"><h2>Property Meaning</h2>${table(["Property", "Meaning"], detail.props.map(([p, m]) => `<tr><td><code>${esc(p)}</code></td><td>${esc(m)}</td></tr>`))}</section></section>${conditionTable}</section>`;
}

function pageIntro(page) {
  return commandPanel(page);
}
function setBusy(text) {
  content.innerHTML = `<div class="loading"><div class="spinner"></div><strong>${esc(text)}</strong><span>Collecting live MongoDB metrics...</span></div>`;
}

function card(label, value, note = "") {
  return `<article class="metric"><span>${esc(label)}</span><strong>${esc(value)}</strong>${note ? `<small>${esc(note)}</small>` : ""}</article>`;
}

function finding(f) {
  if (!f) return "";
  return `<div class="finding ${esc(f.level || "good")}"><b>${esc(f.title || f.level)}</b><p>${esc(f.detail || "")}</p><em>${esc(f.action || "")}</em></div>`;
}

function raw(data) {
  return `<details class="raw"><summary>Raw result</summary><pre>${esc(JSON.stringify(data, null, 2))}</pre></details>`;
}

function table(headers, rows) {
  return `<div class="table-wrap"><table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

function barCanvas(id, titleText) {
  return `<section class="panel"><h2>${esc(titleText)}</h2><canvas id="${id}" height="220"></canvas></section>`;
}

function drawBars(id, labels, values, color = "#1f6f9f") {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = canvas.height * dpr;
  ctx.scale(dpr, dpr);
  const w = rect.width;
  const h = canvas.height / dpr;
  ctx.clearRect(0, 0, w, h);
  const max = Math.max(...values, 1);
  const pad = 36;
  const slot = (w - pad * 2) / Math.max(labels.length, 1);
  ctx.font = "12px Segoe UI";
  ctx.fillStyle = "#5a687a";
  ctx.fillText(`max ${fmt(max)}`, pad, 18);
  values.forEach((v, i) => {
    const bh = (h - 70) * (v / max);
    const x = pad + i * slot + slot * .18;
    const y = h - 40 - bh;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, Math.max(12, slot * .64), bh);
    ctx.fillStyle = "#162033";
    ctx.save();
    ctx.translate(x + 3, h - 24);
    ctx.rotate(-0.35);
    ctx.fillText(String(labels[i]).slice(0, 16), 0, 0);
    ctx.restore();
  });
}

function drawLine(id, labels, values, color = "#0f7b45") {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = canvas.height * dpr;
  ctx.scale(dpr, dpr);
  const w = rect.width;
  const h = canvas.height / dpr;
  ctx.clearRect(0, 0, w, h);
  const max = Math.max(...values, 1);
  const pad = 34;
  ctx.strokeStyle = "#d8e2ee";
  ctx.beginPath(); ctx.moveTo(pad, 18); ctx.lineTo(pad, h - 36); ctx.lineTo(w - 18, h - 36); ctx.stroke();
  ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.beginPath();
  values.forEach((v, i) => {
    const x = pad + (i * (w - pad - 24)) / Math.max(values.length - 1, 1);
    const y = h - 36 - ((h - 62) * v / max);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = "#5a687a"; ctx.font = "12px Segoe UI"; ctx.fillText(`max ${fmt(max)}`, pad, 14);
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value || "-";
}

function updateClusterStrip(summary, members) {
  setText("stripReplicaSet", summary?.setName || "-");
  setText("stripPrimary", summary?.primary || "-");
  setText("stripMembers", Array.isArray(members) && members.length ? members.map(m => m.name).join(", ") : "-");
  setText("stripLabDb", summary?.labDatabase || "-");
}
function renderOverview(data) {
  const r = data.result || data;
  const s = r.summary || {};
  updateClusterStrip(s, r.health?.members || []);
  content.innerHTML = `
    ${pageIntro("overview")}
    <section class="metrics">
      ${card("Replica set", s.setName || "-", `primary ${s.primary || "-"}`)}
      ${card("Members", fmt(s.members), "healthy members expected: 3")}
      ${card("Connections", fmt(s.currentConnections), "current client connections")}
      ${card("Cache used", pct(s.cacheUsedPct), "WiredTiger cache")}
      ${card("Dirty cache", pct(s.dirtyPct), "write/checkpoint pressure")}
      ${card("Collections", fmt(s.collections), s.labDatabase || "lab database")}
    </section>
    <section class="grid two">
      <section class="panel"><h2>Top Findings</h2>${(r.findings || []).slice(0, 8).map(finding).join("") || "<p>No findings.</p>"}</section>
      ${barCanvas("overviewCollections", "Collection Footprint")}
    </section>
    <section class="grid two">
      ${barCanvas("overviewMembers", "Replication Lag Seconds")}
      ${barCanvas("overviewTop", "Top Namespace Activity ms")}
    </section>
    ${raw(r)}
  `;
  drawBars("overviewCollections", (r.storage?.collections || []).map(c => c.ns?.split(".").pop()), (r.storage?.collections || []).map(c => c.storageSize || 0), "#1f6f9f");
  drawBars("overviewMembers", (r.health?.members || []).map(m => m.name), (r.health?.members || []).map(m => m.lagSeconds || 0), "#0f7b45");
  drawBars("overviewTop", (r.mongotop?.rows || []).slice(0, 8).map(x => x.ns), (r.mongotop?.rows || []).slice(0, 8).map(x => x.totalMs), "#9a5b00");
}

function renderReplica(r) {
  const members = r.analyzedMembers || r;
  content.innerHTML = `
    ${pageIntro("replica")}
    <section class="grid two">
      <section class="panel"><h2>Replica Members</h2>${members.map(m => finding(m.analysis)).join("")}</section>
      ${barCanvas("replicaLag", "Lag by Member")}
    </section>
    ${table(["Member", "State", "Health", "Lag", "Ping", "Sync Source"], members.map(m => `<tr><td>${esc(m.name)}</td><td>${esc(m.stateStr)}</td><td>${esc(m.health)}</td><td>${esc(m.lagSeconds)}s</td><td>${esc(m.pingMs ?? "-")}</td><td>${esc(m.syncSourceHost || "-")}</td></tr>`))}
    ${raw(r)}
  `;
  drawBars("replicaLag", members.map(m => m.name), members.map(m => m.lagSeconds || 0), "#0f7b45");
}

function renderServer(r) {
  const s = r.serverStatus || r;
  const a = r.analysis || {};
  const ops = s.opcounters || {};
  content.innerHTML = `
    ${pageIntro(currentPage === "memory" ? "memory" : "server")}
    <section class="metrics">
      ${card("Host", s.host || "-", s.version || "")}
      ${card("Connections", fmt(s.connections?.current), `${fmt(s.connections?.available)} available`)}
      ${card("Resident memory", `${fmt(s.mem?.resident)} MB`, "mongod resident")}
      ${card("Cache used", pct(a.cacheUsedPct), "WiredTiger")}
      ${card("Dirty cache", pct(a.dirtyPct), "WiredTiger")}
      ${card("Network requests", fmt(s.network?.numRequests), "since process start")}
    </section>
    <section class="grid two">
      <section class="panel"><h2>Meaning</h2>${(a.findings || []).map(finding).join("")}</section>
      ${barCanvas("opCounters", "Operation Counters")}
    </section>
    ${raw(r)}
  `;
  drawBars("opCounters", Object.keys(ops), Object.values(ops).map(Number), "#1f6f9f");
}

function renderStorage(r) {
  const rows = r.collections || [];
  content.innerHTML = `
    ${pageIntro("storage")}
    <section class="metrics">
      ${card("Database", r.dbStats?.db || "-", "lab database")}
      ${card("Collections", fmt(r.dbStats?.collections), "collection count")}
      ${card("Objects", fmt(r.dbStats?.objects), "documents")}
      ${card("Data size", mb(r.dbStats?.dataSize), "logical data")}
      ${card("Storage", mb(r.dbStats?.storageSize), "allocated storage")}
      ${card("Index size", mb(r.dbStats?.indexSize), "all indexes")}
    </section>
    <section class="grid two">
      ${barCanvas("collSize", "Collection Storage Size MB")}
      ${barCanvas("indexSize", "Index Size MB")}
    </section>
    ${table(["Namespace", "Docs", "Size MB", "Storage MB", "Index MB", "Indexes", "Meaning"], rows.map(c => `<tr><td>${esc(c.ns)}</td><td>${fmt(c.count)}</td><td>${mb(c.size)}</td><td>${mb(c.storageSize)}</td><td>${mb(c.totalIndexSize)}</td><td>${fmt(c.nindexes)}</td><td>${esc(c.analysis?.title || "")}</td></tr>`))}
    <section class="panel"><h2>Collection Interpretation</h2>${rows.map(c => finding(c.analysis)).join("")}</section>
    ${raw(r)}
  `;
  drawBars("collSize", rows.map(c => c.ns?.split(".").pop()), rows.map(c => c.storageSize || 0), "#1f6f9f");
  drawBars("indexSize", rows.map(c => c.ns?.split(".").pop()), rows.map(c => c.totalIndexSize || 0), "#9a5b00");
}

function renderProfiler(r) {
  const entries = r.recent || [];
  content.innerHTML = `
    ${pageIntro("profiler")}
    <section class="metrics">
      ${card("Profiler level", fmt(r.status?.was), "0 off, 1 slow ops, 2 all ops")}
      ${card("Slow ms", fmt(r.status?.slowms), "threshold")}
      ${card("Entries shown", fmt(entries.length), "recent profile rows")}
    </section>
    <section class="panel"><h2>Profiler Meaning</h2>${entries.map(e => finding(e.analysis)).join("") || "<p>No profiler entries found. Run the slow-query workflow.</p>"}</section>
    ${table(["Time", "Namespace", "Millis", "Docs", "Keys", "Plan"], entries.map(e => `<tr><td>${esc(e.ts || "")}</td><td>${esc(e.ns)}</td><td>${fmt(e.millis)}</td><td>${fmt(e.docsExamined)}</td><td>${fmt(e.keysExamined)}</td><td>${esc(e.planSummary)}</td></tr>`))}
    ${raw(r)}
  `;
}

function renderLogs(r) {
  content.innerHTML = `
    ${pageIntro("logs")}
    <section class="metrics">
      ${card("Slow query lines", fmt(r.counts?.slowQueries), "from getLog")}
      ${card("TLS/Auth lines", fmt(r.counts?.tlsAndAuth), "connection/auth signals")}
      ${card("Storage lines", fmt(r.counts?.indexAndStorage), "checkpoint/index/storage")}
      ${card("Startup warnings", fmt(r.startupWarnings?.length), "startup log")}
    </section>
    <section class="panel"><h2>Meaning</h2>${(r.analysis || []).map(finding).join("")}</section>
    <section class="grid two"><section class="panel"><h2>Slow Query Lines</h2><pre>${esc((r.slowQueries || []).join("\n"))}</pre></section><section class="panel"><h2>TLS/Auth Lines</h2><pre>${esc((r.tlsAndAuth || []).join("\n"))}</pre></section></section>
    ${raw(r)}
  `;
}

function renderMongostat(r) {
  const rows = r.rows || [];
  content.innerHTML = `
    ${pageIntro("mongostat")}
    <section class="panel"><h2>What This Means</h2><p>${esc(r.source)}</p>${(r.analysis || []).map(finding).join("")}</section>
    <section class="grid two">${barCanvas("msOps", "Ops Per Second")}${barCanvas("msCache", "Cache Percent")}</section>
    ${table(["Time", "ins/s", "qry/s", "upd/s", "del/s", "cmd/s", "conn", "cache", "dirty", "net in KB/s", "net out KB/s"], rows.map(x => `<tr><td>${esc(x.time)}</td><td>${x.insert.toFixed(1)}</td><td>${x.query.toFixed(1)}</td><td>${x.update.toFixed(1)}</td><td>${x.delete.toFixed(1)}</td><td>${x.command.toFixed(1)}</td><td>${fmt(x.connections)}</td><td>${pct(x.cacheUsedPct)}</td><td>${pct(x.dirtyPct)}</td><td>${fmt(x.netInKBps)}</td><td>${fmt(x.netOutKBps)}</td></tr>`))}
    ${raw(r)}
  `;
  drawLine("msOps", rows.map((_, i) => i + 1), rows.map(x => x.command + x.query + x.insert + x.update + x.delete), "#1f6f9f");
  drawLine("msCache", rows.map((_, i) => i + 1), rows.map(x => x.cacheUsedPct), "#0f7b45");
}

function renderMongotop(r) {
  const rows = r.rows || [];
  content.innerHTML = `
    ${pageIntro("mongotop")}
    <section class="panel"><h2>What This Means</h2><p>${esc(r.source)}</p>${(r.analysis || []).map(finding).join("") || "<p>No namespace activity during the sample.</p>"}</section>
    ${barCanvas("mtNamespaces", "Namespace Total Time ms")}
    ${table(["Namespace", "Total ms", "Read ms", "Write ms", "Ops", "Read Ops", "Write Ops"], rows.map(x => `<tr><td>${esc(x.ns)}</td><td>${x.totalMs.toFixed(1)}</td><td>${x.readMs.toFixed(1)}</td><td>${x.writeMs.toFixed(1)}</td><td>${fmt(x.totalOps)}</td><td>${fmt(x.readOps)}</td><td>${fmt(x.writeOps)}</td></tr>`))}
    ${raw(r)}
  `;
  drawBars("mtNamespaces", rows.slice(0, 12).map(x => x.ns), rows.slice(0, 12).map(x => x.totalMs), "#9a5b00");
}

function renderDatabaseExplorer(r) {
  const dbs = r.databases || [];
  content.innerHTML = `
    ${pageIntro("databaseExplorer")}
    ${dbs.map(db => `<section class="panel"><h2>${esc(db.name)}</h2><p>Size on disk: ${fmt(db.sizeOnDisk)} bytes</p>${table(["Collection", "Docs", "Size MB", "Storage MB", "Index MB", "Indexes"], (db.collections || []).map(c => `<tr><td>${esc(c.name)}</td><td>${fmt(c.count)}</td><td>${mb(c.size)}</td><td>${mb(c.storageSize)}</td><td>${mb(c.totalIndexSize)}</td><td>${fmt(c.nindexes)}</td></tr>`))}<details><summary>Indexes and sample docs</summary><pre>${esc(JSON.stringify(db.collections, null, 2))}</pre></details></section>`).join("")}
    ${raw(r)}
  `;
}

function liveMongostatTable(rows) {
  return table(["Time", "ins/s", "qry/s", "upd/s", "del/s", "cmd/s", "conn", "cache", "dirty", "net in KB/s", "net out KB/s"], rows.map(x => `<tr><td>${esc(x.time)}</td><td>${Number(x.insert || 0).toFixed(1)}</td><td>${Number(x.query || 0).toFixed(1)}</td><td>${Number(x.update || 0).toFixed(1)}</td><td>${Number(x.delete || 0).toFixed(1)}</td><td>${Number(x.command || 0).toFixed(1)}</td><td>${fmt(x.connections)}</td><td>${pct(x.cacheUsedPct)}</td><td>${pct(x.dirtyPct)}</td><td>${fmt(x.netInKBps)}</td><td>${fmt(x.netOutKBps)}</td></tr>`));
}

function liveMongotopTable(rows) {
  return table(["Namespace", "Total ms", "Read ms", "Write ms", "Ops", "Read Ops", "Write Ops"], rows.map(x => `<tr><td>${esc(x.ns)}</td><td>${Number(x.totalMs || 0).toFixed(1)}</td><td>${Number(x.readMs || 0).toFixed(1)}</td><td>${Number(x.writeMs || 0).toFixed(1)}</td><td>${fmt(x.totalOps)}</td><td>${fmt(x.readOps)}</td><td>${fmt(x.writeOps)}</td></tr>`));
}

function renderLiveLoadStatus(status) {
  const target = document.getElementById("liveLoadResult");
  if (!target) return;
  const statRows = status.mongostat?.rows || [];
  const topRows = status.mongotop?.rows || [];
  target.innerHTML = `
    <section class="metrics">
      ${card("Status", status.status || "idle", status.running ? "running" : "not running")}
      ${card("Iterations", fmt(status.iterations), "load cycles")}
      ${card("Writes", fmt(status.writes), "live_events inserts")}
      ${card("Reads", fmt(status.reads), "query/aggregate returns")}
      ${card("Updates", fmt(status.updates), "order touches")}
      ${card("Batch", fmt(status.batchSize), "docs per cycle")}
    </section>
    ${status.lastError ? `<section class="panel error"><h2>Live Load Error</h2><p>${esc(status.lastError)}</p></section>` : ""}
    <section class="grid two">
      ${barCanvas("liveOps", "Live mongostat Ops Per Second")}
      ${barCanvas("liveTop", "Live mongotop Namespace ms")}
    </section>
    <section class="panel"><h2>Live mongostat</h2>${statRows.length ? liveMongostatTable(statRows.slice(-20).reverse()) : "<p>Waiting for first sample...</p>"}</section>
    <section class="panel"><h2>Live mongotop</h2>${topRows.length ? liveMongotopTable(topRows.slice(0, 20)) : "<p>Waiting for namespace activity...</p>"}</section>
  `;
  drawLine("liveOps", statRows.map((_, i) => i + 1), statRows.map(x => Number(x.command || 0) + Number(x.query || 0) + Number(x.insert || 0) + Number(x.update || 0) + Number(x.delete || 0)), "#1f6f9f");
  drawBars("liveTop", topRows.slice(0, 10).map(x => x.ns), topRows.slice(0, 10).map(x => x.totalMs || 0), "#9a5b00");
}

function stopLivePolling() {
  if (livePollTimer) clearInterval(livePollTimer);
  livePollTimer = null;
}

function startLivePolling() {
  stopLivePolling();
  const poll = async () => {
    try {
      const status = await getLiveLoadStatus();
      renderLiveLoadStatus(status);
      const stopBtn = document.getElementById("stopLiveLoad");
      if (stopBtn) stopBtn.disabled = !status.running;
      const startBtn = document.getElementById("startLiveLoad");
      if (startBtn) startBtn.disabled = !!status.running;
      if (!status.running && ["stopped", "error"].includes(status.status)) stopLivePolling();
    } catch (err) {
      const target = document.getElementById("liveLoadResult");
      if (target) target.innerHTML = `<section class="panel error"><h2>Live Status Failed</h2><p>${esc(err.message)}</p></section>`;
    }
  };
  poll();
  livePollTimer = setInterval(poll, 2000);
}
function renderLoadIntro() {
  content.innerHTML = `
    ${pageIntro("load")}
    <section class="panel split"><div><h2>Live Load Simulation</h2><p>Runs continuous writes, reads, updates, live mongostat, and live mongotop until you press Stop.</p></div><div class="load-form"><label>Batch / sec<input id="liveBatchInput" type="number" value="200" min="10" max="2000" step="10"></label><button id="startLiveLoad">Start Live Load</button><button id="stopLiveLoad" class="danger" disabled>Stop Live Load</button></div></section>
    <section id="liveLoadResult"></section>
    <section class="panel split"><div><h2>Run Custom Load</h2><p>This creates synthetic customers, orders, events and indexes in <code>performance_all_round_lab</code>, then refreshes mongostat/mongotop/storage evidence.</p></div><div class="load-form"><label>Orders<input id="ordersInput" type="number" value="75000" min="1000" step="1000"></label><label>Events<input id="eventsInput" type="number" value="25000" min="1000" step="1000"></label><button id="installLab">Install Lab DB</button><button id="startLoad">Run Load and Analyze</button><button id="startProfile">Run Slow Query Tuning</button></div></section>
    <section id="loadResult"></section>
  `;
  document.getElementById("startLiveLoad").onclick = async () => {
    const target = document.getElementById("liveLoadResult");
    target.innerHTML = `<div class="loading"><div class="spinner"></div><strong>Starting live load...</strong><span>Beginning continuous workload and live sampling.</span></div>`;
    const status = await startLiveLoad(Number(document.getElementById("liveBatchInput").value));
    renderLiveLoadStatus(status);
    startLivePolling();
  };
  document.getElementById("stopLiveLoad").onclick = async () => {
    const status = await stopLiveLoad();
    renderLiveLoadStatus(status);
    startLivePolling();
  };
  startLivePolling();
  document.getElementById("installLab").onclick = async () => {
    const target = document.getElementById("loadResult");
    target.innerHTML = `<div class="loading"><div class="spinner"></div><strong>Installing lab database...</strong><span>Creating customers, orders, events, and indexes if missing.</span></div>`;
    const result = await post("/api/install-lab", { orderCount: 10000, eventCount: 5000, config: config() });
    lastResults.load = result;
    target.innerHTML = `<section class="metrics">${card("Installed", result.installed ? "Yes" : "Already exists", result.database || "lab database")}${card("Customers", fmt(result.counts?.customers), "records")}${card("Orders", fmt(result.counts?.orders), "records")}${card("Events", fmt(result.counts?.events), "records")}</section><section class="panel"><h2>Install Result</h2><p>${esc(result.message || "Completed")}</p></section>${result.storage ? raw(result) : raw(result)}`;
  };
  document.getElementById("startLoad").onclick = async () => {
    const target = document.getElementById("loadResult");
    target.innerHTML = `<div class="loading"><div class="spinner"></div><strong>Generating load...</strong><span>This can take a minute.</span></div>`;
    const result = await post("/api/load", { orderCount: Number(document.getElementById("ordersInput").value), eventCount: Number(document.getElementById("eventsInput").value), config: config() });
    lastResults.load = result;
    target.innerHTML = `${pageIntro("load")}<section class="metrics">${card("Customers", fmt(result.counts.customers), "created")}${card("Orders", fmt(result.counts.orders), "created")}${card("Events", fmt(result.counts.events), "created")}</section><section class="grid two">${barCanvas("loadColls", "Collection Storage After Load")}${barCanvas("loadStat", "mongostat Command Rate")}</section>${raw(result)}`;
    drawBars("loadColls", result.storage.collections.map(c => c.ns.split(".").pop()), result.storage.collections.map(c => c.storageSize || 0), "#1f6f9f");
    drawLine("loadStat", result.mongostat.rows.map((_, i) => i + 1), result.mongostat.rows.map(x => x.command + x.insert + x.query), "#0f7b45");
  };
  document.getElementById("startProfile").onclick = async () => {
    const target = document.getElementById("loadResult");
    target.innerHTML = `<div class="loading"><div class="spinner"></div><strong>Running profiler comparison...</strong><span>Dropping/recreating tuning index inside lab DB.</span></div>`;
    const result = await post("/api/profile-slow-query", { config: config() });
    target.innerHTML = `${pageIntro("profiler")}<section class="metrics">${card("Docs before", fmt(result.comparison.docsExaminedBefore), "COLLSCAN baseline")}${card("Docs after", fmt(result.comparison.docsExaminedAfter), "indexed plan")}${card("Time before", `${fmt(result.comparison.timeBeforeMs)} ms`, "baseline")}${card("Time after", `${fmt(result.comparison.timeAfterMs)} ms`, "after index")}</section><section class="panel"><h2>Meaning</h2>${finding(result.analysis)}</section>${barCanvas("profileCompare", "Before vs After Docs Examined")}${raw(result)}`;
    drawBars("profileCompare", ["before", "after"], [result.comparison.docsExaminedBefore, result.comparison.docsExaminedAfter], "#1f6f9f");
  };
}

function renderGeneric(page, r) {
  if (page === "replica") return renderReplica(r);
  if (page === "server" || page === "memory") return renderServer(r);
  if (page === "storage") return renderStorage(r);
  if (page === "profiler") return renderProfiler(r);
  if (page === "logs") return renderLogs(r);
  if (page === "mongostat") return renderMongostat(r);
  if (page === "mongotop") return renderMongotop(r);
  if (page === "databaseExplorer") return renderDatabaseExplorer(r);
}

async function loadPage(page) {
  currentPage = page;
  if (page !== "load") stopLivePolling();
  const [t, st] = pageMeta[page];
  title.textContent = t;
  subtitle.textContent = st;
  navs.forEach(n => n.classList.toggle("active", n.dataset.page === page));
  if (page === "load") return renderLoadIntro();
  content.innerHTML = `<div class="loading"><div class="spinner"></div><strong>Loading ${esc(t)}...</strong><span>Collecting live MongoDB metrics.</span></div>`;
  try {
    const result = page === "overview" ? await overview() : await check(pageCheckMap[page] || page);
    lastResults[page] = result;
    if (page === "overview") renderOverview(result); else renderGeneric(page, result);
  } catch (err) {
    content.innerHTML = `<section class="panel error"><h2>Unable to load ${esc(t)}</h2><p>${esc(err.message)}</p></section>`;
  }
}

navs.forEach(btn => btn.addEventListener("click", () => loadPage(btn.dataset.page)));
document.getElementById("refreshPage").onclick = () => loadPage(currentPage);
document.getElementById("runAll").onclick = async () => {
  currentPage = "overview";
  navs.forEach(n => n.classList.toggle("active", n.dataset.page === "overview"));
  title.textContent = "Full Analysis";
  subtitle.textContent = "Running complete analyzer.";
  content.innerHTML = `<div class="loading"><div class="spinner"></div><strong>Running full analysis...</strong><span>Gathering health, server, storage, logs, profiler, mongostat, and mongotop.</span></div>`;
  try { renderOverview(await overview()); } catch (err) { content.innerHTML = `<section class="panel error"><h2>Full analysis failed</h2><p>${esc(err.message)}</p></section>`; }
};

loadPage("overview");


