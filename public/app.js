const content = document.getElementById("content");
const title = document.getElementById("pageTitle");
const subtitle = document.getElementById("pageSubtitle");
const navs = [...document.querySelectorAll(".nav")];
let currentPage = "overview";
let lastResults = {};


const pageDetails = {
  overview: {
    command: `Composite call: /api/dashboard/overview
Runs MongoDB APIs: hello, replSetGetStatus, serverStatus, dbStats, collStats, system.profile, getLog, top`,
    props: [
      ["setName", "Replica set name returned by hello. Confirms which cluster is being analyzed."],
      ["primary", "Current writable primary member. Writes and load generation target this member through the driver."],
      ["currentConnections", "Open MongoDB client connections right now."],
      ["cacheUsedPct", "WiredTiger cache currently used compared with configured cache maximum."],
      ["dirtyPct", "Dirty cache percentage. Higher values can indicate write/checkpoint pressure."],
      ["findings", "Plain-English health findings computed from the raw metrics."],
    ],
  },
  replica: {
    command: `db.adminCommand({ hello: 1 })
db.adminCommand({ replSetGetStatus: 1 })`,
    props: [
      ["stateStr", "Replica member role such as PRIMARY or SECONDARY."],
      ["health", "1 means the member is reachable from the current node; 0 means unhealthy/unreachable."],
      ["optimeDate", "Latest replicated operation timestamp for the member."],
      ["lagSeconds", "Primary optime minus secondary optime. Large values mean replication lag."],
      ["pingMs", "Heartbeat network latency in milliseconds."],
      ["syncSourceHost", "Member from which this secondary is syncing."],
    ],
  },
  server: {
    command: `db.adminCommand({ serverStatus: 1 })`,
    props: [
      ["connections.current", "Current open client connections."],
      ["connections.available", "Remaining connection capacity."],
      ["opcounters", "Cumulative insert/query/update/delete/getmore/command counters since process start."],
      ["mem.resident", "Approximate mongod resident memory in MB."],
      ["network.numRequests", "Total network requests handled by mongod."],
      ["locks", "Lock acquisition counters and wait counters by resource."],
    ],
  },
  memory: {
    command: `db.adminCommand({ serverStatus: 1 }).wiredTiger.cache
db.adminCommand({ serverStatus: 1 }).mem`,
    props: [
      ["bytesCurrentlyInCache", "Current bytes held in WiredTiger cache."],
      ["maxBytesConfigured", "Configured WiredTiger cache maximum."],
      ["trackedDirtyBytes", "Dirty bytes waiting to be written/checkpointed."],
      ["pagesReadIntoCache", "Pages read from disk into cache. Fast growth can mean working set misses."],
      ["pagesWrittenFromCache", "Pages written from cache to disk."],
      ["evictionServerUnableToReachGoal", "Eviction pressure signal. Non-zero growth deserves attention."],
    ],
  },
  storage: {
    command: `db.runCommand({ dbStats: 1, scale: 1024 * 1024 })
db.runCommand({ collStats: "<collection>", scale: 1024 * 1024 })`,
    props: [
      ["objects", "Total documents in the database."],
      ["dataSize", "Logical uncompressed data size in MB."],
      ["storageSize", "Allocated physical collection storage in MB."],
      ["indexSize / totalIndexSize", "Storage used by indexes."],
      ["nindexes", "Number of indexes on the collection."],
      ["indexPct", "Index footprint compared with data plus index footprint."],
    ],
  },
  profiler: {
    command: `db.runCommand({ profile: -1 })
db.system.profile.find(...).sort({ ts: -1 }).limit(25)`,
    props: [
      ["millis", "Operation execution time in milliseconds."],
      ["docsExamined", "Documents scanned by the operation. High values often indicate inefficient query shape."],
      ["keysExamined", "Index keys scanned. Shows index use and selectivity."],
      ["planSummary", "Short winning plan summary such as COLLSCAN or IXSCAN."],
      ["ns", "Namespace: database.collection affected by the operation."],
      ["command", "Original command/query shape captured by profiler."],
    ],
  },
  logs: {
    command: `db.adminCommand({ getLog: "global" })
db.adminCommand({ getLog: "startupWarnings" })`,
    props: [
      ["slowQueries", "Log lines containing slow query messages."],
      ["tlsAndAuth", "TLS handshake, SSL, authentication, and login-related log lines."],
      ["indexAndStorage", "Index build, checkpoint, WiredTiger, and storage-related log lines."],
      ["startupWarnings", "Warnings emitted during MongoDB startup."],
      ["recent", "Most recent in-memory global log lines returned by getLog."],
    ],
  },
  mongostat: {
    command: `Sample A: db.adminCommand({ serverStatus: 1 })
wait 1 second
Sample B: db.adminCommand({ serverStatus: 1 })
rate = (B counter - A counter) / seconds`,
    props: [
      ["insert/query/update/delete", "Per-second operation rates calculated from opcounters deltas."],
      ["getmore", "Cursor getMore operations per second."],
      ["command", "MongoDB command operations per second."],
      ["netInKBps / netOutKBps", "Network throughput calculated from serverStatus network byte deltas."],
      ["cacheUsedPct", "WiredTiger cache usage percentage at sample time."],
      ["dirtyPct", "Dirty cache percentage at sample time."],
    ],
  },
  mongotop: {
    command: `Sample A: db.adminCommand({ top: 1 })
wait 1 second
Sample B: db.adminCommand({ top: 1 })
namespace time = B namespace counters - A namespace counters`,
    props: [
      ["ns", "Namespace measured by MongoDB top command."],
      ["totalMs", "Total time spent on that namespace during the sample."],
      ["readMs", "Read-lock/read time during the sample."],
      ["writeMs", "Write-lock/write time during the sample."],
      ["totalOps", "Operations observed on the namespace during the sample."],
      ["readOps/writeOps", "Read and write operation counts in the sample window."],
    ],
  },
  databaseExplorer: {
    command: `db.adminCommand({ listDatabases: 1, nameOnly: false })
db.listCollections()
db.runCommand({ collStats: "<collection>", scale: 1024 * 1024 })
db.collection.getIndexes()
db.collection.find({}).limit(3)`,
    props: [
      ["sizeOnDisk", "Database size on disk reported by listDatabases."],
      ["collections", "Collections discovered in each non-system database."],
      ["count", "Document count from collStats."],
      ["indexes", "Index definitions returned by getIndexes."],
      ["sample", "First few documents shown for shape inspection."],
    ],
  },
  load: {
    command: `Custom load workflow:
1. db.dropDatabase() for performance_all_round_lab
2. insertMany(customers, orders, events)
3. createIndex(...) for tuning indexes
4. collect storage, mongostat, and mongotop output`,
    props: [
      ["customers/orders/events", "Synthetic documents created for the lab workload."],
      ["storage", "dbStats and collStats immediately after load."],
      ["mongostat", "serverStatus delta samples collected after load."],
      ["mongotop", "top namespace timing collected after load."],
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

async function check(name) { return post("/api/run-check", { check: name, config: config() }); }
async function overview() { return post("/api/dashboard/overview", { config: config() }); }

function commandPanel(page) {
  const detail = pageDetails[page];
  if (!detail) return "";
  return `<section class="grid two explain-grid"><section class="panel command-panel"><h2>Command Used</h2><pre>${esc(detail.command)}</pre></section><section class="panel glossary-panel"><h2>Property Meaning</h2>${table(["Property", "Meaning"], detail.props.map(([p, m]) => `<tr><td><code>${esc(p)}</code></td><td>${esc(m)}</td></tr>`))}</section></section>`;
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

function renderOverview(data) {
  const r = data.result || data;
  const s = r.summary || {};
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

function renderLoadIntro() {
  content.innerHTML = `
    ${pageIntro("load")}
    <section class="panel split"><div><h2>Run Custom Load</h2><p>This creates synthetic customers, orders, events and indexes in <code>performance_all_round_lab</code>, then refreshes mongostat/mongotop/storage evidence.</p></div><div class="load-form"><label>Orders<input id="ordersInput" type="number" value="75000" min="1000" step="1000"></label><label>Events<input id="eventsInput" type="number" value="25000" min="1000" step="1000"></label><button id="startLoad">Run Load and Analyze</button><button id="startProfile">Run Slow Query Tuning</button></div></section>
    <section id="loadResult"></section>
  `;
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
  const [t, st] = pageMeta[page];
  title.textContent = t;
  subtitle.textContent = st;
  navs.forEach(n => n.classList.toggle("active", n.dataset.page === page));
  if (page === "load") return renderLoadIntro();
  content.innerHTML = `<div class="loading"><div class="spinner"></div><strong>Loading ${esc(t)}...</strong><span>Collecting live MongoDB metrics.</span></div>`;
  try {
    const result = page === "overview" ? await overview() : await check(page === "memory" ? "serverStatus" : page);
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


