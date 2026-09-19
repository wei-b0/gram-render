import { describe, expect, it } from "vitest";
import { deriveCandidates } from "../src/derive/candidates.js";

const AGENTS = [
  { name: "cart-resolver", status: "running", uptime: "3h 12m", tasks_done: 142 },
  { name: "mail-digest", status: "degraded", uptime: "0h 44m", tasks_done: 9 },
  { name: "backup-worker", status: "idle", uptime: "12h 01m", tasks_done: 0 },
];

describe("deriveCandidates", () => {
  it("derives key-based headings, array representations, and status children", () => {
    const result = deriveCandidates("Show these agents with their status and actions.", { agents: AGENTS });

    // Heading variants from the context key.
    const heading = result.questions.find((q) => q.key === "heading");
    expect(heading).toBeDefined();
    const headingIds = heading!.options.map((option) => option.id);
    expect(headingIds).toContain("h_agents");

    // Array representation question with both options.
    const items = result.questions.find((q) => q.key === "items_agents");
    expect(items).toBeDefined();
    const optionIds = items!.options.map((option) => option.id);
    expect(optionIds).toContain("sections");
    expect(optionIds).toContain("list_agents");

    // "sections" option expands to one candidate per agent.
    const sectionsOption = items!.options.find((option) => option.id === "sections")!;
    expect(sectionsOption.candidateIds).toHaveLength(3);

    // Per-agent sections bake Field/Status children (status recognized).
    const first = result.candidates.find((candidate) => candidate.id === sectionsOption.candidateIds[0])!;
    expect(first.element.type).toBe("Section");
    expect(first.element.props["title"]).toBe("cart-resolver");
    const statusChild = first.element.children!.find((child) => child.type === "Status")!;
    expect(statusChild.props).toMatchObject({ level: "success", text: "Status: running" });

    // Degraded agent maps to warning.
    const mailId = sectionsOption.candidateIds[1]!;
    const mail = result.candidates.find((candidate) => candidate.id === mailId)!;
    const mailStatus = mail.element.children!.find((child) => child.type === "Status")!;
    expect(mailStatus.props).toMatchObject({ level: "warning" });
  });

  it("derives heading candidates from quoted prompt strings", () => {
    const result = deriveCandidates('Compose a status message. Quote "Order confirmation" for the heading.', {
      order: { id: "#4821", total: "€28.50" },
    });
    const heading = result.questions.find((q) => q.key === "heading")!;
    const ids = heading.options.map((option) => option.id);
    expect(ids).toContain("h_order_confirmation");
    expect(ids).toContain("h_order"); // key-derived fallback
  });

  it("derives buttons from context.actions and prompt quotes", () => {
    const result = deriveCandidates('Show the deploy. Quote "Redeploy" as a button too.', {
      deploy: { version: "1.4.2", status: "failed" },
      actions: [{ label: "View logs", action: "view_logs", payload: { run: 42 }, style: "primary" }],
    });
    const logsButton = result.candidates.find((candidate) => candidate.id === "btn_view_logs");
    expect(logsButton).toBeDefined();
    expect(logsButton!.element.props).toMatchObject({ label: "View logs", action: "view_logs", style: "primary" });

    const redeploy = result.candidates.find((candidate) => candidate.id === "btn_redeploy");
    expect(redeploy).toBeDefined();
    expect(redeploy!.element.props).toMatchObject({ label: "Redeploy", action: "redeploy" });

    // Standard buttons present as low-priority candidates.
    expect(result.candidates.find((candidate) => candidate.id === "btn_refresh")).toBeDefined();
    // Context actions dedupe against standard buttons.
    expect(result.candidates.filter((candidate) => candidate.id === "btn_refresh")).toHaveLength(1);
  });

  it("derives variant questions for top-level scalar lines (status vs field)", () => {
    const result = deriveCandidates("Show the service.", { status: "degraded", region: "eu-1" });
    const statusLine = result.questions.find((q) => q.key === "line_status");
    expect(statusLine).toBeDefined();
    const optionIds = statusLine!.options.map((option) => option.id);
    expect(optionIds).toContain("st_status");
    expect(optionIds).toContain("f_status");

    const plainLine = result.questions.find((q) => q.key === "line_region");
    expect(plainLine).toBeDefined();
  });

  it("derives object body questions (section vs flat) and nested arrays", () => {
    const result = deriveCandidates("Show the order.", {
      order: { id: "#4821", status: "processing", items: [{ name: "Beans", qty: 2, price: "€24.00" }] },
    });
    const body = result.questions.find((q) => q.key === "body_order");
    expect(body).toBeDefined();
    expect(body!.options.map((option) => option.id)).toEqual(["sec_order", "flat"]);

    const items = result.questions.find((q) => q.key === "items_order.items");
    expect(items).toBeDefined();
  });

  it("compacts object list items with their quantity and price", () => {
    const result = deriveCandidates("Show the order.", {
      items: [
        { name: "Canvas Backpack", quantity: 1, price: "$54.00" },
        { name: "Travel Bottle", quantity: 2, price: "$15.25" },
      ],
    });
    const list = result.candidates.find((candidate) => candidate.id === "list_items")!;
    expect(list.element.type).toBe("List");
    expect(list.element.props["items"]).toEqual([
      "Canvas Backpack ×1 — $54.00",
      "Travel Bottle ×2 — $15.25",
    ]);
  });

  it("derives link buttons for URL values (top-level variant and nested include)", () => {
    // Top-level scalar: URL becomes one variant option of the line question.
    const topLevel = deriveCandidates("Show the doc.", { url: "https://example.com/guide" });
    const line = topLevel.questions.find((q) => q.key === "line_url")!;
    const optionIds = line.options.map((option) => option.id);
    expect(optionIds).toContain("lnk_url");
    expect(optionIds).toContain("f_url");
    const link = topLevel.candidates.find((candidate) => candidate.id === "lnk_url")!;
    expect(link.element.type).toBe("Button");
    expect(link.element.props).toMatchObject({ label: "URL", url: "https://example.com/guide" });

    // Nested URL: the section/flat lines keep it as a Field, plus an include
    // question offers a tappable link button.
    const nested = deriveCandidates("Show the doc.", { doc: { url: "https://example.com/guide" } });
    const include = nested.questions.find((q) => q.key === "btn_url_url");
    expect(include).toBeDefined();
    const nestedLink = nested.candidates.find((candidate) => candidate.id === "lnk_url")!;
    expect(nestedLink.element.type).toBe("Button");
    expect(nestedLink.element.props).toMatchObject({ label: "URL", url: "https://example.com/guide" });
  });

  it("caps array expansion and reports truncation", () => {
    const items = Array.from({ length: 12 }, (_, index) => ({ name: `item-${index}`, n: index }));
    const result = deriveCandidates("Show items.", { items }, { maxItemsPerArray: 8 });
    expect(result.warnings.some((warning) => warning.includes("'items'"))).toBe(true);
    const list = result.candidates.find((candidate) => candidate.id === "list_items")!;
    const rendered = list.element.props["items"] as string[];
    expect(rendered).toHaveLength(9); // 8 items + "+4 more"
    expect(rendered[8]).toBe("+4 more");
  });

  it("caps total candidates with a warning", () => {
    const context: Record<string, unknown> = {};
    for (let index = 0; index < 60; index += 1) context[`field_${index}`] = index;
    const result = deriveCandidates("Show fields.", context, { maxCandidates: 20 });
    expect(result.warnings.some((warning) => warning.includes("Candidate cap"))).toBe(true);
    expect(result.candidates.length).toBeLessThanOrEqual(20);
  });

  it("offers only the standard buttons for a contentless prompt (composer all-omit → unavailable)", () => {
    const result = deriveCandidates("Hello.", undefined);
    expect(result.questions.map((question) => question.key)).toEqual(["btn_refresh", "btn_contact_support"]);
  });
});

describe("derive 0.1.0 upgrades", () => {
  const AGENTS = [
    { name: "cart-resolver", status: "running", uptime: "3h 12m" },
    { name: "mail-digest", status: "degraded", uptime: "0h 44m" },
    { name: "backup-worker", status: "idle", uptime: "12h 01m" },
  ];

  it("offers a uniform-records table as a third array representation", () => {
    const result = deriveCandidates("Show the fleet.", { agents: AGENTS });
    const items = result.questions.find((question) => question.key === "items_agents")!;
    const tableOption = items.options.find((option) => option.id === "tbl_agents");
    expect(tableOption).toBeDefined();
    expect(items.options[items.options.length - 1]!.id).toBe("tbl_agents"); // appended last

    const table = result.candidates.find((candidate) => candidate.id === "tbl_agents")!;
    expect(table.element.type).toBe("Table");
    expect(table.element.props).toMatchObject({
      columns: ["Name", "Status", "Uptime"],
      rows: [
        ["cart-resolver", "running", "3h 12m"],
        ["mail-digest", "degraded", "0h 44m"],
        ["backup-worker", "idle", "12h 01m"],
      ],
    });
    expect(table.resource).toBe("items_agents");
  });

  it("drops the table option for ragged or non-tabular data", () => {
    const ragged = deriveCandidates("Show.", { agents: [{ name: "a", status: "running" }, { name: "b", extra: 1 }] });
    expect(ragged.candidates.find((candidate) => candidate.id === "tbl_agents")).toBeUndefined();

    const nested = deriveCandidates("Show.", { logs: [{ name: "a", payload: { deep: true } }] });
    expect(nested.candidates.find((candidate) => candidate.id === "tbl_logs")).toBeUndefined();
  });

  it("derives Note candidates from hint-shaped keys", () => {
    const result = deriveCandidates("Show the board.", { agents: AGENTS, hint: "Use /use <name> to select" });
    const line = result.questions.find((question) => question.key === "line_hint")!;
    const noteOption = line.options.find((option) => option.id === "note_hint");
    expect(noteOption).toBeDefined();
    const note = result.candidates.find((candidate) => candidate.id === "note_hint")!;
    expect(note.element.type).toBe("Note");
    expect(note.element.props).toMatchObject({ text: "Use /use <name> to select" });
  });

  it("humanizes ISO datetimes and date-keyed epochs, leaves other numbers alone", () => {
    const result = deriveCandidates("Show.", {
      last_seen: "2026-09-19T08:30:00Z",
      created_at: 1789807200, // 2026-09-19 08:40 UTC
      updated_ms: 1789807200000,
      tasks_done: 142,
      uptime: "3h 12m",
    });
    const seen = result.candidates.find((candidate) => candidate.id === "f_last_seen")!;
    expect(seen.element.props).toMatchObject({ label: "Last Seen", value: "2026-09-19 08:30" });
    const created = result.candidates.find((candidate) => candidate.id === "f_created_at")!;
    expect((created.element.props as { value: string }).value).toBe("2026-09-19 08:40"); // UTC
    const updated = result.candidates.find((candidate) => candidate.id === "f_updated_ms")!;
    expect((updated.element.props as { value: string }).value).toBe("2026-09-19 08:40");
    const tasks = result.candidates.find((candidate) => candidate.id === "f_tasks_done")!;
    expect((tasks.element.props as { value: string }).value).toBe("142"); // no date-shaped key → untouched
    const uptime = result.candidates.find((candidate) => candidate.id === "f_uptime")!;
    expect((uptime.element.props as { value: string }).value).toBe("3h 12m");
  });

  it("renders null values as an em dash and joins scalar arrays", () => {
    const result = deriveCandidates("Show the agent.", {
      agent: { name: "cart-resolver", last_error: null, tags: ["build", "deploy"] },
    });
    const section = result.candidates.find((candidate) => candidate.id === "sec_agent")!;
    const children = section.element.children!;
    const error = children.find((child) => child.props["label"] === "Last Error")!;
    expect((error.props as { value: string }).value).toBe("—");
    const tags = children.find((child) => child.props["label"] === "Tags")!;
    expect((tags.props as { value: string }).value).toBe("build, deploy");
  });

  it("pluralizes section hints with -es forms (statuses → status)", () => {
    const result = deriveCandidates("Show.", {
      statuses: [{ name: "a", state: "ok" }, { name: "b", state: "ok" }],
      boxes: [{ name: "b1" }],
    });
    const items = result.questions.find((question) => question.key === "items_statuses")!;
    const sectionsOption = items.options.find((option) => option.id === "sections")!;
    expect(sectionsOption.description).toContain("per status ");
    const boxes = result.questions.find((question) => question.key === "items_boxes")!;
    expect(boxes.options.find((option) => option.id === "sections")!.description).toContain("per box ");
  });

  it("warns once (not per drop) when the candidate cap is hit", () => {
    const context: Record<string, unknown> = {};
    for (let index = 0; index < 60; index += 1) context[`field_${index}`] = index;
    const result = deriveCandidates("Show fields.", context, { maxCandidates: 20 });
    const capWarnings = result.warnings.filter((warning) => warning.includes("Candidate cap"));
    expect(capWarnings).toHaveLength(1);
  });

  it("turns quoted URLs into link buttons", () => {
    const result = deriveCandidates('Offer "https://t.me/gramrender" as a button.', {});
    const link = result.candidates.find((candidate) => candidate.id === "btn_https_t_me_gramrender");
    expect(link).toBeDefined();
    expect(link!.element.type).toBe("Button");
    expect(link!.element.props).toMatchObject({ url: "https://t.me/gramrender" });
    expect(link!.element.props["action"]).toBeUndefined();
  });
});
