/**
 * The five gallery fixtures — deliberately different application domains so
 * gram-render doesn't look tied to any one vertical. Each fixture is plain
 * consumer data: `context()` returns a fresh deep copy (fixture actions mutate
 * it), and `prompt` is the natural-language render intent for that fixture.
 *
 * `applyFixtureAction` is the consumer-owned "backend": it mutates the
 * context exactly the way a real application would, then the bot re-renders
 * through gram-render. The library itself never touches any of this.
 */

export type FixtureId = "order" | "incident" | "deploy" | "usage" | "ticket";

export interface Fixture {
  id: FixtureId;
  title: string;
  /** Gallery one-liner naming the component mix it exercises. */
  blurb: string;
  prompt: string;
  context(): Record<string, unknown>;
}

// The "Left-handed turbo encabulator" is deliberate: no model would invent
// that string, so seeing it in the rendered message proves every word came
// from this context. Note: status "packed" renders as ℹ️ (info) because
// gram-render's generic status vocabulary doesn't special-case it — intended.
const ORDER_TEMPLATE = {
  order: {
    id: "#1842",
    customer: "Maya Patel",
    status: "processing",
    payment: "paid",
    placed_at: "2026-09-19T08:41:00Z",
    items: [
      { name: "Left-handed turbo encabulator (rev. C)", qty: 1, price: "$84.00" },
      { name: "Acme rocket skates, pair", qty: 2, price: "$9.00" },
    ],
    total: "$102.00",
    delivery: {
      method: "Courier",
      eta: "2026-09-20 14:00–18:00",
      address: "742 Evergreen Terrace",
    },
  },
  actions: [
    { label: "Mark as packed", action: "mark_packed", payload: { order: "#1842" }, style: "primary" },
    { label: "Cancel order", action: "cancel_order", payload: { order: "#1842" }, style: "danger" },
  ],
};

const INCIDENT_TEMPLATE = {
  incident: {
    id: "INC-2917",
    service: "checkout-api",
    severity: "critical",
    status: "investigating",
    started_at: "2026-09-19T09:02:00Z",
    affected_users: 1240,
    summary: "Checkout error rate spiking for EU users",
    timeline: [
      "09:02 error rate crossed 5%",
      "09:05 on-call paged automatically",
      "09:12 correlated with upstream provider incident",
    ],
  },
  actions: [
    { label: "Acknowledge", action: "ack_incident", payload: { id: "INC-2917" }, style: "primary" },
    { label: "Resolve", action: "resolve_incident", payload: { id: "INC-2917" }, style: "success" },
  ],
};

const DEPLOY_TEMPLATE = {
  deploy: {
    build: "b-7742",
    service: "web",
    stage: "canary",
    status: "live",
    commit: "9f3c2e1",
    duration: "6m 12s",
    checks: [
      { name: "lint", result: "pass", ms: 42 },
      { name: "unit", result: "pass", ms: 310 },
      { name: "e2e", result: "pass", ms: 1280 },
      { name: "load", result: "warn", ms: 4100 },
    ],
    logs: "12:01 build started\n12:04 unit tests green\n12:06 canary deployed at 10%",
  },
  actions: [
    { label: "Promote to production", action: "promote_build", payload: { build: "b-7742" }, style: "primary" },
    { label: "Roll back", action: "rollback_build", payload: { build: "b-7742" }, style: "danger" },
  ],
};

const USAGE_TEMPLATE = {
  usage: {
    account: "acme-corp",
    period: "last 30 days",
    plan: "Team",
    seats: 24,
    requests: "1.9M",
    error_rate: "0.02%",
    rows: [
      { feature: "API", calls: "1.2M", share: "63%" },
      { feature: "Exports", calls: "410K", share: "21%" },
      { feature: "Webhooks", calls: "290K", share: "15%" },
    ],
    note: "Counts exclude sandbox traffic.",
  },
  actions: [
    { label: "Export CSV", action: "export_report", payload: { range: "30d" }, style: "primary" },
  ],
};

const TICKET_TEMPLATE = {
  ticket: {
    id: "TCK-558",
    subject: "Password reset email never arrives",
    status: "open",
    priority: "normal",
    requester: "jules@example.com",
    opened_at: "2026-09-19T10:12:00Z",
    tags: ["login", "email"],
    messages: [
      "10:12 customer reported the reset email never arrives",
      "10:15 provider logs show a bounce at mx2",
      "10:20 retry queued with a corrected return-path",
    ],
  },
  actions: [
    { label: "Close ticket", action: "close_ticket", payload: { ticket: "TCK-558" }, style: "success" },
    { label: "Escalate", action: "escalate_ticket", payload: { ticket: "TCK-558" }, style: "danger" },
  ],
};

export const FIXTURES: Record<FixtureId, Fixture> = {
  order: {
    id: "order",
    title: "Order #1842",
    blurb: "sections, statuses, item list, two actions",
    prompt: 'Show this order. Quote "Order #1842" as the heading. Expose the actions.',
    context: () => structuredClone(ORDER_TEMPLATE) as Record<string, unknown>,
  },
  incident: {
    id: "incident",
    title: "Incident INC-2917",
    blurb: "alert, timeline quote, status levels",
    prompt: 'Show this incident. Quote "INC-2917" as the heading. Expose the actions.',
    context: () => structuredClone(INCIDENT_TEMPLATE) as Record<string, unknown>,
  },
  deploy: {
    id: "deploy",
    title: "Deployment b-7742",
    blurb: "table, code block, mono fields",
    prompt: 'Show this deployment. Quote "Deployment b-7742" as the heading. Expose the actions.',
    context: () => structuredClone(DEPLOY_TEMPLATE) as Record<string, unknown>,
  },
  usage: {
    id: "usage",
    title: "Usage — 30 days",
    blurb: "table, note footer, key numbers",
    prompt: 'Show this usage report. Quote "Usage — last 30 days" as the heading. Expose the action.',
    context: () => structuredClone(USAGE_TEMPLATE) as Record<string, unknown>,
  },
  ticket: {
    id: "ticket",
    title: "Ticket TCK-558",
    blurb: "quote thread, list, priority status",
    prompt: 'Show this support ticket. Quote "TCK-558" as the heading. Expose the actions.',
    context: () => structuredClone(TICKET_TEMPLATE) as Record<string, unknown>,
  },
};

export const FIXTURE_IDS: FixtureId[] = ["order", "incident", "deploy", "usage", "ticket"];

/** Sample data for the playground (no actions — those belong to an app). */
export function orderSample(): Record<string, unknown> {
  const { order } = structuredClone(ORDER_TEMPLATE) as { order: Record<string, unknown> };
  return { order };
}

/** Which fixture a callback action belongs to. */
export const KNOWN_ACTIONS: Record<string, FixtureId> = {
  mark_packed: "order",
  cancel_order: "order",
  ack_incident: "incident",
  resolve_incident: "incident",
  promote_build: "deploy",
  rollback_build: "deploy",
  export_report: "usage",
  close_ticket: "ticket",
  escalate_ticket: "ticket",
};

function clock(now: Date = new Date()): string {
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

/**
 * The consumer-owned action handler. Mutates `context` the way a real
 * application backend would and returns the toast label — or null when the
 * action is not part of the loaded fixture's story.
 */
export function applyFixtureAction(
  context: Record<string, unknown>,
  action: string,
  _payload: Record<string, unknown>,
): string | null {
  const order = context["order"] as Record<string, unknown> | undefined;
  const incident = context["incident"] as Record<string, unknown> | undefined;
  const deploy = context["deploy"] as Record<string, unknown> | undefined;
  const usage = context["usage"] as Record<string, unknown> | undefined;
  const ticket = context["ticket"] as Record<string, unknown> | undefined;

  switch (action) {
    case "mark_packed":
      if (!order) return null;
      order["status"] = "packed";
      ((order["delivery"] as Record<string, unknown>) ?? {})["note"] =
        `Packed ${clock()}, awaiting courier pickup`;
      return "Packed ✓";
    case "cancel_order":
      if (!order) return null;
      order["status"] = "cancelled";
      context["actions"] = []; // nothing left to do — the keyboard visibly empties
      return "Order cancelled";
    case "ack_incident":
      if (!incident) return null;
      incident["severity"] = "acknowledged";
      incident["acknowledged_by"] = "demo on-call";
      return "Acknowledged ✓";
    case "resolve_incident":
      if (!incident) return null;
      incident["status"] = "resolved";
      return "Resolved ✓";
    case "promote_build":
      if (!deploy) return null;
      deploy["stage"] = "production";
      deploy["status"] = "live";
      return "Promoted to production ✓";
    case "rollback_build":
      if (!deploy) return null;
      deploy["stage"] = "canary";
      deploy["status"] = "rolled_back";
      return "Rolled back";
    case "export_report":
      if (!usage) return null;
      context["export"] = { status: "queued", range: "30d", format: "csv" };
      return "Export queued";
    case "close_ticket":
      if (!ticket) return null;
      ticket["status"] = "closed";
      return "Ticket closed ✓";
    case "escalate_ticket":
      if (!ticket) return null;
      ticket["priority"] = "high";
      ticket["assigned_team"] = "Tier 2";
      return "Escalated to Tier 2";
    default:
      return null;
  }
}
