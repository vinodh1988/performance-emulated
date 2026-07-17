const ids = [
  "sshUser",
  "sshHost",
  "sshKey",
  "mongoHost",
  "mongoPort",
  "mongoUser",
  "mongoPassword",
  "authDb",
  "tlsCAFile",
  "tlsPEMKeyFile",
  "labDb",
];

const output = document.getElementById("output");
const statusText = document.getElementById("status");

function config() {
  return Object.fromEntries(ids.map(id => [id, document.getElementById(id).value.trim()]));
}

function setBusy(busy, label = "Running") {
  document.querySelectorAll("button").forEach(btn => { btn.disabled = busy; });
  statusText.textContent = busy ? label : "Idle";
}

function formatResult(result) {
  const lines = [];
  lines.push(`# ${result.label || "Result"}`);
  lines.push(`ok: ${result.ok}`);
  if (result.code !== undefined) lines.push(`exitCode: ${result.code}`);
  if (result.startedAt) lines.push(`startedAt: ${result.startedAt}`);
  if (result.finishedAt) lines.push(`finishedAt: ${result.finishedAt}`);
  if (result.command) {
    lines.push("");
    lines.push("## Remote command");
    lines.push(result.command);
  }
  if (result.stdout) {
    lines.push("");
    lines.push("## stdout");
    lines.push(result.stdout);
  }
  if (result.stderr) {
    lines.push("");
    lines.push("## stderr");
    lines.push(result.stderr);
  }
  if (result.error) {
    lines.push("");
    lines.push("## error");
    lines.push(result.error);
  }
  return lines.join("\n");
}

async function post(url, body, label) {
  setBusy(true, label);
  output.textContent = `${label}...`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    output.textContent = formatResult(data);
  } catch (err) {
    output.textContent = err.stack || err.message;
  } finally {
    setBusy(false);
  }
}

document.querySelectorAll("[data-check]").forEach(btn => {
  btn.addEventListener("click", () => {
    post("/api/run-check", { config: config(), check: btn.dataset.check }, `Running ${btn.textContent}`);
  });
});

document.querySelectorAll("[data-tool]").forEach(btn => {
  btn.addEventListener("click", () => {
    post("/api/run-tool", { config: config(), tool: btn.dataset.tool }, `Running ${btn.dataset.tool}`);
  });
});

document.querySelector("[data-special='logs']").addEventListener("click", () => {
  post("/api/logs", { config: config() }, "Analyzing logs");
});

document.querySelector("[data-special='os']").addEventListener("click", () => {
  post("/api/os", { config: config() }, "Checking OS resources");
});

document.getElementById("runLoad").addEventListener("click", () => {
  post("/api/load", {
    config: config(),
    orderCount: Number(document.getElementById("orderCount").value),
    eventCount: Number(document.getElementById("eventCount").value),
  }, "Generating synthetic load");
});

document.getElementById("runProfile").addEventListener("click", () => {
  post("/api/profile-slow-query", { config: config() }, "Running profiler slow query");
});

fetch("/api/default-config")
  .then(res => res.json())
  .then(defaults => {
    for (const [key, value] of Object.entries(defaults)) {
      const el = document.getElementById(key);
      if (el && value) el.value = value;
    }
  })
  .catch(() => {});
