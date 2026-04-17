import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { openAgendaBrowserInteractive } from "./browser.ts";
import { AGENDA_TOOL_NAMES, registerAgendaTools } from "./tools.ts";
import { refreshAgendaWidget } from "./widget.ts";

export default function (pi: ExtensionAPI) {
  registerAgendaTools(pi);

  pi.registerCommand("agenda-browser", {
    description: "Open interactive agenda browser",
    handler: async (_args, ctx) => {
      await openAgendaBrowserInteractive(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    refreshAgendaWidget(ctx);
  });

  pi.on("tool_result", async (event, ctx) => {
    if (AGENDA_TOOL_NAMES.has(event.toolName)) {
      refreshAgendaWidget(ctx);
    }
  });
}
