import { config } from "zod";

// The MCP SDK constructs schemas during import; configure their non-eval path first.
config({ jitless: true });
