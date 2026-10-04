# Part schema

Mapping agents write ONE JSON file: `{"parts": [ ... ]}`, one entry per folder they were assigned.

```json
{
  "id": "orders-api",                    // folder name, unique
  "path": "services/orders-api",         // repo-relative folder (or a single file)
  "kind": "service | job | library | tool",
  "name": "Orders API",                  // human name
  "summary": "Takes customer orders, reserves stock and asks payments to charge the card.",
  "details": "At most 3 short plain sentences a new engineer needs. No jargon without explaining it.",
  "exposes": [                           // how work ENTERS this part
    {"type": "http | pubsub | cron | cli | rpc | function", "what": "POST /orders", "ref": "services/orders-api/routes.go:31"}
  ],
  "uses": [                              // what this part talks to OUTSIDE itself
    {"target": "Postgres", "how": "stores orders", "ref": "services/orders-api/store.go:42"},
    {"target": "payments-worker", "how": "publishes order.created", "ref": "..."}
  ],
  "publishes": ["order.created"],        // exact queue/topic names (or config keys if names come from env)
  "subscribes": ["payment.settled"],
  "flows": [                             // 1-4 most important flows; libraries may have 0
    {
      "title": "A customer places an order",
      "trigger": "HTTP: POST /orders",
      "steps": [
        {"from": "HTTP", "to": "OrderHandler.Create", "text": "The order request arrives", "fn": "Create", "ref": "services/orders-api/routes.go:31"},
        {"from": "OrderHandler.Create", "to": "Inventory.Reserve", "text": "Reserves stock for each item", "fn": "Reserve", "ref": "..."},
        {"from": "OrderHandler.Create", "to": "Postgres", "text": "Saves the order as pending", "fn": "InsertOrder", "ref": "..."},
        {"from": "OrderHandler.Create", "to": "Kafka", "text": "Publishes order.created for payments", "fn": "Publish", "ref": "..."}
      ]
    }
  ]
}
```

Rules
- Plain English. Short. A smart person new to the codebase must get it in one read. Each step text at most 12 words.
- `target`, `from`, `to`: use another part's `id` when talking to an internal part; use product names for outside systems: Postgres, MongoDB, Redis, Kafka, S3, Stripe, Slack, OpenAI, Sentry, etc. Within a flow, function actors are short `Type.Method` or `function` names.
- `ref` = exact repo-relative `path:line` where that thing happens (the call, the route registration, the handler). Every `ref` is machine-checked: the file must exist, and `fn` (when given) must appear within 5 lines of that line. Never guess a line; open the file and check.
- Flows follow a real request/call path in order, function by function. Prefer the flows that matter most.
- Do not invent. If unsure, leave it out.
- Paths are relative to the repository root.
