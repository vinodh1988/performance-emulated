const ids = [
  "mongoUri",
  "mongoUser",
  "mongoPassword",
  "authDb",
  "tlsCAFile",
  "tlsPEMKeyFile",
  "labDb",
  "tlsAllowInvalidHostnames",
];

const output = document.getElementById("output");
const statusText = document.getElementById("status");

function config() {
  const values = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    values[id] = el.type === "checkbox" ? el.checked : el.value.trim();
  }
  return values;
}

function setBusy(busy, label = "Running") {
  document.querySelectorAll("button").forEach(btn => { btn.disabled = busy; });
  statusText.textContent = busy ? label : "Idle";
}

function formatResult(result) {
  return JSON.stringify(result, null, 2);
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
      if (!el) continue;
      if (el.type === "checkbox") el.checked = Boolean(value);
      else if (value) el.value = value;
    }
  })
  .catch(() => {});
