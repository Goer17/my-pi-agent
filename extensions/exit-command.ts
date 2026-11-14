/**
 * Exit Command Extension
 *
 * Adds /exit as an alias for /quit, allowing you to exit pi cleanly.
 *
 * Usage:
 *   /exit
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("exit", {
		description: "Exit pi cleanly (alias for /quit)",
		handler: async (_args, ctx) => {
			ctx.shutdown();
		},
	});
}
