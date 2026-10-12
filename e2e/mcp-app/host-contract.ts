import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";

export type FixtureName =
  | "overlap"
  | "bounds"
  | "legends"
  | "legend-order"
  | "properties"
  | "empty-controls"
  | "registration-failure";
export interface HostToolCall {
  name: string;
  args: Record<string, unknown>;
}
export interface MCPTestHost {
  ready: boolean;
  calls: HostToolCall[];
  unexpected: string[];
  closedIds: string[];
  previewIds: string[];
  delayedPreviewIds: string[];
  cspViolations: Array<{ blockedURI: string; directive: string }>;
  show(fixture: FixtureName): Promise<void>;
  context(context: McpUiHostContext): Promise<void>;
  failNext(kind: "style" | "resource"): void;
  delayNextPreview(): void;
  releasePreviews(): void;
  teardown(): Promise<void>;
}

declare global {
  interface Window {
    /** Test host state only; no application or renderer internals. */
    mcpTestHost: MCPTestHost;
  }
}
