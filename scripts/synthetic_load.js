const labName = "__LAB_DB__";
const orderTarget = __ORDER_COUNT__;
const eventTarget = __EVENT_COUNT__;
const lab = db.getSiblingDB(labName);

print("=== PERFORMANCE ALL ROUND SYNTHETIC LOAD ===");
printjson({
  database: labName,
  orderTarget,
  eventTarget,
  startedAt: new Date()
});

lab.dropDatabase();

const regions = ["HYD", "MUM", "BLR", "DEL", "CHN", "PUN"];
const statuses = ["NEW", "PAID", "PACKED", "SHIPPED", "DELIVERED", "CANCELLED", "RETURNED"];
const categories = ["mobile", "laptop", "tablet", "router", "camera", "speaker", "monitor", "keyboard"];
const channels = ["web", "mobile", "store", "partner", "api"];
const eventTypes = ["login", "search", "cart", "checkout", "payment", "support", "export"];

let customers = [];
for (let i = 1; i <= 20000; i++) {
  customers.push({
    customerId: "CUST" + String(i).padStart(6, "0"),
    region: regions[i % regions.length],
    city: ["Hyderabad", "Mumbai", "Bengaluru", "Delhi", "Chennai", "Pune"][i % 6],
    tier: ["bronze", "silver", "gold", "platinum"][i % 4],
    active: i % 13 !== 0,
    lifetimeValue: 500 + ((i * 149) % 240000),
    createdAt: new Date(Date.now() - (i % 900) * 86400000)
  });
  if (customers.length === 1000) {
    lab.customers.insertMany(customers, { ordered: false });
    customers = [];
  }
}
if (customers.length) lab.customers.insertMany(customers, { ordered: false });

let orders = [];
for (let i = 1; i <= orderTarget; i++) {
  orders.push({
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
    items: [
      { sku: "SKU" + (i % 7000), qty: (i % 4) + 1 },
      { sku: "SKU" + ((i + 17) % 7000), qty: (i % 3) + 1 }
    ]
  });
  if (orders.length === 5000) {
    lab.orders.insertMany(orders, { ordered: false });
    orders = [];
  }
}
if (orders.length) lab.orders.insertMany(orders, { ordered: false });

let events = [];
for (let i = 1; i <= eventTarget; i++) {
  events.push({
    eventId: "EVT" + String(i).padStart(9, "0"),
    customerId: "CUST" + String((i % 20000) + 1).padStart(6, "0"),
    eventType: eventTypes[i % eventTypes.length],
    success: i % 17 !== 0,
    responseMs: 20 + ((i * 37) % 4000),
    createdAt: new Date(Date.now() - (i % 1440) * 30000),
    meta: {
      device: ["mobile", "desktop", "tablet"][i % 3],
      campaign: "campaign-" + (i % 80),
      ip: "10.40." + (i % 255) + "." + ((i * 11) % 255)
    }
  });
  if (events.length === 5000) {
    lab.events.insertMany(events, { ordered: false });
    events = [];
  }
}
if (events.length) lab.events.insertMany(events, { ordered: false });

print("=== INDEXES ===");
printjson(lab.orders.createIndex({ region: 1, status: 1, amount: 1, createdAt: -1 }, { name: "idx_region_status_amount_createdAt" }));
printjson(lab.orders.createIndex({ customerId: 1, createdAt: -1 }, { name: "idx_customer_createdAt" }));
printjson(lab.orders.createIndex({ category: 1, notes: 1 }, { name: "idx_category_notes" }));
printjson(lab.events.createIndex({ eventType: 1, responseMs: -1, createdAt: -1 }, { name: "idx_eventType_response_createdAt" }));
printjson(lab.events.createIndex({ createdAt: 1 }, { name: "idx_events_createdAt_ttl", expireAfterSeconds: 604800 }));
printjson(lab.customers.createIndex(
  { region: 1, lifetimeValue: -1 },
  { name: "idx_active_customer_value", partialFilterExpression: { active: true, lifetimeValue: { $gte: 5000 } } }
));

print("=== BASELINE EXPLAIN ===");
const filter = { region: "HYD", status: "PAID", amount: { $gt: 100000 } };
printjson({
  matchingOrders: lab.orders.countDocuments(filter),
  explain: lab.orders.find(filter).sort({ createdAt: -1 }).limit(25).explain("executionStats").executionStats
});

print("=== STATS ===");
printjson({
  customers: lab.customers.countDocuments(),
  orders: lab.orders.countDocuments(),
  events: lab.events.countDocuments(),
  dbStatsMB: lab.stats(1024 * 1024)
});

print("=== SYNTHETIC LOAD COMPLETE ===");
printjson({ completedAt: new Date() });
