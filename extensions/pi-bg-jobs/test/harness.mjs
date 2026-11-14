/**
 * Standalone test harness for pi-bg-jobs (one-shot mode).
 *
 *   node test/harness.mjs
 *
 * Fakes a minimal ExtensionAPI so the extension can be exercised without
 * starting a real pi session. Requires Node >= 23.6 (native TS type stripping).
 */
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const handlers = new Map();
const tools = new Map();
const commands = new Map();
const userMessages = [];
const notifications = [];
const widgets = new Map();

const pi = {
	on(event, handler) {
		if (!handlers.has(event)) handlers.set(event, []);
		handlers.get(event).push(handler);
	},
	registerTool(def) {
		tools.set(def.name, def);
	},
	registerCommand(name, def) {
		commands.set(name, def);
	},
	registerShortcut() {},
	registerFlag() {},
	sendUserMessage(content, options) {
		userMessages.push({ content, options });
	},
	sendMessage() {},
	appendEntry() {},
	async exec() {
		return { stdout: "", stderr: "", code: 0, killed: false };
	},
};

let idle = true;
const ctx = {
	cwd: root,
	mode: "tui",
	hasUI: true,
	isIdle: () => idle,
	signal: undefined,
	ui: {
		notify: (message, type) => notifications.push({ message, type }),
		setWidget: (key, content) => widgets.set(key, content),
		setStatus: () => {},
	},
};

async function emit(event, ...args) {
	for (const handler of handlers.get(event) ?? []) await handler(...args);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const mod = await import(join(root, "index.ts"));
mod.default(pi);
await emit("session_start", { reason: "startup" }, ctx);

const expectedTools = ["bg_start", "bg_status", "bg_output", "bg_kill", "bg_wait"];
for (const name of expectedTools) {
	if (!tools.has(name)) throw new Error(`missing tool: ${name}`);
}
const expectedCommands = ["jobs", "jobs-kill", "jobs-clear"];
for (const name of expectedCommands) {
	if (!commands.has(name)) throw new Error(`missing command: ${name}`);
}
if (tools.get("bg_start").parameters.properties.times) {
	throw new Error("bg_start must not expose a times parameter");
}
console.log("✓ tools and commands registered (no times parameter)");

// 1. start + automatic notification with a non-zero exit code
const start = await tools.get("bg_start").execute("t1", { command: "echo hello-mail; sleep 0.4; echo bye; exit 3" }, undefined, undefined, ctx);
if (!start.content[0].text.includes("bg-1")) throw new Error("bg_start did not return a job id");
if (start.content[0].text.includes("done")) throw new Error("bg_start blocked");
if (start.content[0].text.includes("runs:")) throw new Error("one-shot start should not mention runs");
await sleep(1_100);
if (userMessages.length !== 1) throw new Error(`expected 1 user message, got ${userMessages.length}`);
const first = String(userMessages[0].content);
for (const needle of ["bg-1", "exit code 3", "hello-mail", "bye", "automatic notification"]) {
	if (!first.includes(needle)) throw new Error(`exit message missing "${needle}":\n${first}`);
}
if (userMessages[0].options !== undefined) throw new Error("idle notification should not use deliverAs");
if (first.includes("restarted")) throw new Error("one-shot job must not restart");
console.log("✓ one-shot non-zero exit delivered as user message while idle");

// 2. busy agent: notifications are held until agent_settled (covers Esc abort)
idle = false;
const beforeBusy = userMessages.length;
await tools.get("bg_start").execute("t2", { command: "echo busy-output", label: "busy-job" }, undefined, undefined, ctx);
await sleep(1_000);
if (userMessages.length !== beforeBusy) throw new Error("busy notification should wait for agent_settled");
idle = true;
await emit("agent_settled", {}, ctx);
await sleep(50);
if (userMessages.length !== beforeBusy + 1) throw new Error(`expected 1 notification after settle, got ${userMessages.length - beforeBusy}`);
if (userMessages[beforeBusy].options !== undefined) throw new Error("settled notification should not use deliverAs");
if (!String(userMessages[beforeBusy].content).includes("busy-output")) throw new Error("missing busy-job output");
console.log("✓ busy notifications are held and sent on agent_settled (Esc-safe)");

// 3. bg_output / bg_status
const out = await tools.get("bg_output").execute("t3", { id: "bg-1", lines: 2 }, undefined, undefined, ctx);
if (!out.content[0].text.includes("bye")) throw new Error("bg_output missing output");
if (out.content[0].text.includes("run 1/1")) throw new Error("one-shot output should not mention run numbers");
const status = await tools.get("bg_status").execute("t4", {}, undefined, undefined, ctx);
if (!status.content[0].text.includes("bg-1") || !status.content[0].text.includes("bg-2")) throw new Error("bg_status list wrong");
if (status.content[0].text.includes("runs:")) throw new Error("one-shot status should not mention runs");
console.log("✓ bg_output and bg_status work");

// 4. bg_wait returns immediately for a finished job
const waited = await tools.get("bg_wait").execute("t5", { id: "bg-1", timeout: 1 }, undefined, undefined, ctx);
if (!waited.content[0].text.includes("finished")) throw new Error("bg_wait on finished job wrong");
console.log("✓ bg_wait on finished job");

// 5. explicit kill
idle = true;
await tools.get("bg_start").execute("t6", { command: "sleep 30", label: "victim" }, undefined, undefined, ctx);
const killed = await tools.get("bg_kill").execute("t7", { id: "bg-3" }, undefined, undefined, ctx);
if (!killed.content[0].text.includes("SIGTERM")) throw new Error("bg_kill failed");
await sleep(1_000);
if (!String(userMessages.at(-1).content).includes("killed")) throw new Error("kill notification missing");
console.log("✓ bg_kill delivers kill notification");

// 6. timeout kills the process (and does not restart)
await tools.get("bg_start").execute("t8", { command: "sleep 30", label: "timeout-victim", timeout: 0.3 }, undefined, undefined, ctx);
await sleep(1_300);
const timeoutText = String(userMessages.at(-1).content);
if (!timeoutText.includes("timeout")) throw new Error("timeout notification missing");
if (timeoutText.includes("restarted")) throw new Error("one-shot timeout must not restart");
console.log("✓ timeout kills and notifies");

// 7. widget shows running jobs
await tools.get("bg_start").execute("t9", { command: "sleep 30", label: "long-runner" }, undefined, undefined, ctx);
await sleep(50);
if (!(widgets.get("bg-jobs") ?? []).some((line) => line.includes("bg-5"))) throw new Error("widget missing running job");
console.log("✓ widget lists running jobs");

// 8. ANSI escape codes stripped, multi-byte UTF-8 preserved
await tools.get("bg_start").execute("t10", { command: "printf '\\033[31m彩色\\033[0m\\n'" }, undefined, undefined, ctx);
await sleep(1_000);
const colored = String(userMessages.at(-1).content);
if (!colored.includes("彩色")) throw new Error("UTF-8 output lost");
if (colored.includes("\u001b[")) throw new Error("ANSI escape leaked into notification");
console.log("✓ ANSI stripped, UTF-8 preserved");

// 9. a grandchild holding the inherited stdout pipe must not delay the notification
const beforeOrphan = userMessages.length;
await tools.get("bg_start").execute("t11", { command: "echo ORPHAN_OUT; (sleep 5; echo LATE) &" }, undefined, undefined, ctx);
await sleep(1_300);
if (userMessages.length !== beforeOrphan + 1) throw new Error("notification delayed by inherited stdio pipe");
if (!String(userMessages.at(-1).content).includes("ORPHAN_OUT")) throw new Error("orphan test output missing");
console.log("✓ inherited stdio pipe does not hang the notification");

// 10. shutdown kills running jobs and clears state
await emit("session_shutdown", { reason: "quit" }, ctx);
const after = await tools.get("bg_status").execute("t12", {}, undefined, undefined, ctx);
if (!after.content[0].text.includes("No background jobs")) throw new Error("jobs not cleared on shutdown");
console.log("✓ session_shutdown cleans up");

rmSync(join(tmpdir(), "pi-bg-jobs-counter"), { force: true });
console.log("\nAll checks passed.");
process.exit(0);
