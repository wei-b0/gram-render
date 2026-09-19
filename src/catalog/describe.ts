import type { GramElement } from "../spec/schema.js";

/**
 * Short human-readable summaries of spec elements — the `content` field sent
 * to the evaluator in edit mode (`already_built`) and used in step
 * descriptions. Never includes raw props beyond the display strings JEV needs
 * to reason about the visible message.
 */
export function describeElement(element: GramElement): string {
  const props = element.props as Record<string, unknown>;
  switch (element.type) {
    case "Message":
      return "the message itself";
    case "Heading":
      return `heading "${props["text"]}"`;
    case "Text":
      return `text "${truncate(String(props["text"]), 60)}"`;
    case "Section":
      return `section "${props["title"]}"`;
    case "Divider":
      return "divider line";
    case "Field":
      return `field "${props["label"]}: ${truncate(String(props["value"]), 40)}"`;
    case "List": {
      const items = (props["items"] as string[]) ?? [];
      return `list of ${items.length} line(s), starting "${truncate(items[0] ?? "", 40)}"`;
    }
    case "Status":
      return `status ${props["level"]} "${truncate(String(props["text"]), 40)}"`;
    case "Code":
      return `code block (${props["language"] ?? "plain"})`;
    case "Quote":
      return `quote "${truncate(String(props["text"]), 60)}"`;
    case "Alert":
      return `alert ${props["level"]}${props["title"] ? ` "${props["title"]}"` : ""}: "${truncate(String(props["text"]), 40)}"`;
    case "Table": {
      const rows = (props["rows"] as string[][] | undefined) ?? [];
      const columns = props["columns"] as string[] | undefined;
      const width = columns?.length ?? rows[0]?.length ?? 0;
      const first = columns?.[0] ? `, starting "${truncate(columns[0], 24)}"` : "";
      return `table ${rows.length}×${width}${first}`;
    }
    case "Note":
      return `note "${truncate(String(props["text"]), 60)}"`;
    case "ButtonRow":
      return "button row";
    case "Button": {
      const target = props["url"] ? `link to ${truncate(String(props["url"]), 40)}` : props["disabled"] ? "disabled button" : `action ${String(props["action"])}`;
      return `button "${props["label"]}" (${target})`;
    }
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
