const labName = "__LAB_DB__";
const lab = db.getSiblingDB(labName);

print("=== PROFILER SLOW QUERY COMPARISON ===");
printjson({ database: labName, startedAt: new Date() });

print("=== ENABLE PROFILER ===");
printjson(lab.setProfilingLevel(1, { slowms: 10, sampleRate: 1.0 }));

print("=== DROP TUNING INDEX TO FORCE BASELINE ===");
try {
  lab.orders.dropIndex("idx_region_status_amount_createdAt");
  print("Dropped idx_region_status_amount_createdAt");
} catch (err) {
  print("Index was not present: " + err.message);
}

const filter = { region: "HYD", status: "PAID", amount: { $gt: 100000 } };
printjson({ matchingDocuments: lab.orders.countDocuments(filter) });

print("=== BEFORE INDEX ===");
const before = lab.orders.find(filter).sort({ createdAt: -1 }).limit(25).explain("executionStats");
printjson({
  winningPlan: before.queryPlanner.winningPlan,
  executionStats: {
    nReturned: before.executionStats.nReturned,
    executionTimeMillis: before.executionStats.executionTimeMillis,
    totalKeysExamined: before.executionStats.totalKeysExamined,
    totalDocsExamined: before.executionStats.totalDocsExamined
  }
});
print("Returned before index: " + lab.orders.find(filter).sort({ createdAt: -1 }).limit(25).toArray().length);

print("=== CREATE INDEX ===");
printjson(lab.orders.createIndex(
  { region: 1, status: 1, amount: 1, createdAt: -1 },
  { name: "idx_region_status_amount_createdAt" }
));

print("=== AFTER INDEX ===");
const after = lab.orders.find(filter).sort({ createdAt: -1 }).limit(25).explain("executionStats");
printjson({
  winningPlan: after.queryPlanner.winningPlan,
  executionStats: {
    nReturned: after.executionStats.nReturned,
    executionTimeMillis: after.executionStats.executionTimeMillis,
    totalKeysExamined: after.executionStats.totalKeysExamined,
    totalDocsExamined: after.executionStats.totalDocsExamined
  }
});
print("Returned after index: " + lab.orders.find(filter).sort({ createdAt: -1 }).limit(25).toArray().length);

print("=== RECENT PROFILER ENTRIES ===");
printjson(lab.system.profile.find({}, {
  ts: 1,
  ns: 1,
  op: 1,
  millis: 1,
  docsExamined: 1,
  keysExamined: 1,
  planSummary: 1,
  command: 1
}).sort({ ts: -1 }).limit(10).toArray());

print("=== DISABLE PROFILER ===");
printjson(lab.setProfilingLevel(0));
printjson(lab.getProfilingStatus());
