const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT || 3010);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DOCS = path.join(ROOT, "docs");

const DEFAULT_CONFIG = {
  sshUser: process.env.PERF_SSH_USER || "ubuntu",
  sshHost: process.env.PERF_SSH_HOST || "18.61.157.150",
  sshKey: process.env.PERF_SSH_KEY || "D:\\mongo.pem",
  mongoHost: process.env.PERF_MONGO_HOST || "127.0.0.1",
  mongoPort: process.env.PERF_MONGO_PORT || "27017",
  mongoUser: process.env.PERF_MONGO_USER || "siteAdmin",
  mongoPassword: process.env.PERF_MONGO_PASSWORD || "",
  authDb: process.env.PERF_AUTH_DB || "admin",
  tlsCAFile: process.env.PERF_TLS_CA_FILE || "/etc/mongodb/ssl/mongodb-ca.crt",
  tlsPEMKeyFile: process.env.PERF_TLS_PEM_KEY_FILE || "/etc/mongodb/ssl/windows-client.pem",
  labDb: process.env.PERF_LAB_DB || "performance_all_round_lab",
};

function json(res, status, body) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(data);
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
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function mergeConfig(input = {}) {
  return { ...DEFAULT_CONFIG, ...input };
}

function remoteMongoshCommand(config, js) {
  const c = mergeConfig(config);
  if (!c.mongoPassword) {
    throw new Error("MongoDB password is required. Enter it in the dashboard or set PERF_MONGO_PASSWORD.");
  }
  const args = [
    "sudo mongosh",
    "--tls",
    "--tlsCAFile", shellQuote(c.tlsCAFile),
    "--tlsCertificateKeyFile", shellQuote(c.tlsPEMKeyFile),
    "--host", shellQuote(c.mongoHost),
    "--port", shellQuote(c.mongoPort),
    "-u", shellQuote(c.mongoUser),
    "-p", shellQuote(c.mongoPassword),
    "--authenticationDatabase", shellQuote(c.authDb),
    "--quiet",
    "--eval", shellQuote(js),
  ];
  return args.join(" ");
}

function remoteToolCommand(config, tool, extraArgs) {
  const c = mergeConfig(config);
  if (!c.mongoPassword) {
    throw new Error("MongoDB password is required. Enter it in the dashboard or set PERF_MONGO_PASSWORD.");
  }
  const args = [
    `sudo ${tool}`,
    "--host", shellQuote(c.mongoHost),
    "--port", shellQuote(c.mongoPort),
    "--username", shellQuote(c.mongoUser),
    "--password", shellQuote(c.mongoPassword),
    "--authenticationDatabase", shellQuote(c.authDb),
    "--ssl",
    "--sslCAFile", shellQuote(c.tlsCAFile),
    "--sslPEMKeyFile", shellQuote(c.tlsPEMKeyFile),
    extraArgs,
  ];
  return args.join(" ");
}

function sshRun(config, remoteCommand, timeoutMs = 45000) {
  const c = mergeConfig(config);
  return new Promise((resolve) => {
    const startedAt = new Date();
    const args = [
      "-i", c.sshKey,
      "-o", "StrictHostKeyChecking=no",
      `${c.sshUser}@${c.sshHost}`,
      remoteCommand,
    ];
    const child = spawn("ssh", args, { shell: false });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      stderr += `\nCommand timed out after ${timeoutMs} ms`;
    }, timeoutMs);
    child.stdout.on("data", data => { stdout += data.toString(); });
    child.stderr.on("data", data => { stderr += data.toString(); });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        startedAt,
        finishedAt: new Date(),
        command: redact(remoteCommand),
        stdout,
        stderr,
      });
    });
    child.on("error", err => {
      clearTimeout(timer);
      resolve({
        ok: false,
        code: -1,
        startedAt,
        finishedAt: new Date(),
        command: redact(remoteCommand),
        stdout,
        stderr: err.message,
      });
    });
  });
}

function redact(text) {
  return String(text).replace(/--password\s+'[^']*'/g, "--password '<redacted>'").replace(/-p\s+'[^']*'/g, "-p '<redacted>'");
}

const checks = {
  health: {
    label: "Replica Set Health",
    js: "printjson({hello: db.getSiblingDB('admin').runCommand({hello:1}), members: rs.status().members.map(m => ({name:m.name,stateStr:m.stateStr,health:m.health,optimeDate:m.optimeDate,pingMs:m.pingMs,syncSourceHost:m.syncSourceHost||''}))})",
  },
  serverStatus: {
    label: "Server Status",
    js: "const s=db.serverStatus(); printjson({host:s.host,version:s.version,uptime:s.uptime,connections:s.connections,opcounters:s.opcounters,mem:s.mem,wiredTigerCache:{bytesCurrentlyInCache:s.wiredTiger.cache['bytes currently in the cache'],maxBytesConfigured:s.wiredTiger.cache['maximum bytes configured'],trackedDirtyBytes:s.wiredTiger.cache['tracked dirty bytes in the cache'],pagesReadIntoCache:s.wiredTiger.cache['pages read into cache'],pagesWrittenFromCache:s.wiredTiger.cache['pages written from cache']},locks:s.locks})",
  },
  currentOps: {
    label: "Current Operations",
    js: "printjson(db.getSiblingDB('admin').aggregate([{ $currentOp: { allUsers: true, idleConnections: false } }, { $project: { opid:1, active:1, secs_running:1, op:1, ns:1, waitingForLock:1, client:1, desc:1 } }, { $limit: 20 }]).toArray())",
  },
  profiler: {
    label: "Profiler Recent Entries",
    js: "const d=db.getSiblingDB('performance_all_round_lab'); printjson({status:d.getProfilingStatus(), recent:d.system.profile.find({}, {ts:1,ns:1,op:1,millis:1,docsExamined:1,keysExamined:1,planSummary:1,command:1}).sort({ts:-1}).limit(10).toArray()})",
  },
  storage: {
    label: "Database Storage Stats",
    js: "const d=db.getSiblingDB('performance_all_round_lab'); printjson({dbStats:d.stats(1024*1024),orders:d.orders.stats(1024*1024),events:d.events.stats(1024*1024)})",
  },
  replicationLag: {
    label: "Replication Lag",
    js: "const st=rs.status(); const p=st.members.find(m=>m.stateStr==='PRIMARY'); printjson(st.members.map(m=>({name:m.name,stateStr:m.stateStr,health:m.health,optimeDate:m.optimeDate,lagSeconds:p&&m.optimeDate?((p.optimeDate-m.optimeDate)/1000):0,pingMs:m.pingMs,syncSourceHost:m.syncSourceHost||''})))",
  },
};

function loadScript(name) {
  return fs.readFileSync(path.join(ROOT, "scripts", name), "utf8");
}

async function handleApi(req, res) {
  try {
    if (req.method === "GET" && req.url === "/api/default-config") {
      const safe = { ...DEFAULT_CONFIG, mongoPassword: "" };
      return json(res, 200, safe);
    }

    if (req.method === "POST" && req.url === "/api/run-check") {
      const body = await readBody(req);
      const check = checks[body.check];
      if (!check) return json(res, 400, { error: "Unknown check" });
      const output = await sshRun(body.config, remoteMongoshCommand(body.config, check.js));
      return json(res, 200, { label: check.label, ...output });
    }

    if (req.method === "POST" && req.url === "/api/run-tool") {
      const body = await readBody(req);
      if (body.tool === "mongostat") {
        const output = await sshRun(body.config, remoteToolCommand(body.config, "mongostat", "--rowcount 5 1"), 20000);
        return json(res, 200, { label: "mongostat", ...output });
      }
      if (body.tool === "mongotop") {
        const output = await sshRun(body.config, remoteToolCommand(body.config, "mongotop", "1 --rowcount 5"), 20000);
        return json(res, 200, { label: "mongotop", ...output });
      }
      return json(res, 400, { error: "Unknown tool" });
    }

    if (req.method === "POST" && req.url === "/api/logs") {
      const body = await readBody(req);
      const remote = "echo '=== RECENT LOGS ==='; sudo tail -n 120 /var/log/mongodb/mongod.log; echo '=== SLOW QUERY LOGS ==='; sudo grep -i 'slow query' /var/log/mongodb/mongod.log | tail -n 40; echo '=== TLS AUTH ERRORS ==='; sudo grep -i 'SSLHandshakeFailed\\|authentication\\|Successfully authenticated' /var/log/mongodb/mongod.log | tail -n 40";
      const output = await sshRun(body.config, remote, 30000);
      return json(res, 200, { label: "MongoDB Log Analysis", ...output });
    }

    if (req.method === "POST" && req.url === "/api/os") {
      const body = await readBody(req);
      const remote = "echo '=== DISK ==='; df -h; echo '=== MEMORY ==='; free -m; echo '=== TOP ==='; top -b -n 1 | head -n 25";
      const output = await sshRun(body.config, remote, 20000);
      return json(res, 200, { label: "OS Memory Disk CPU", ...output });
    }

    if (req.method === "POST" && req.url === "/api/load") {
      const body = await readBody(req);
      const c = mergeConfig(body.config);
      const js = loadScript("synthetic_load.js")
        .replaceAll("__LAB_DB__", c.labDb)
        .replaceAll("__ORDER_COUNT__", String(Math.max(1000, Number(body.orderCount || 75000))))
        .replaceAll("__EVENT_COUNT__", String(Math.max(1000, Number(body.eventCount || 25000))));
      const output = await sshRun(body.config, remoteMongoshCommand(body.config, js), 120000);
      return json(res, 200, { label: "Synthetic Load Generation", ...output });
    }

    if (req.method === "POST" && req.url === "/api/profile-slow-query") {
      const body = await readBody(req);
      const c = mergeConfig(body.config);
      const js = loadScript("profile_slow_query.js").replaceAll("__LAB_DB__", c.labDb);
      const output = await sshRun(body.config, remoteMongoshCommand(body.config, js), 90000);
      return json(res, 200, { label: "Profiler Slow Query Comparison", ...output });
    }

    return json(res, 404, { error: "API route not found" });
  } catch (err) {
    return json(res, 500, { error: err.message });
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
    const type = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".svg": "image/svg+xml",
    }[ext] || "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) return handleApi(req, res);
  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`performance-all-round dashboard running at http://localhost:${PORT}`);
});

