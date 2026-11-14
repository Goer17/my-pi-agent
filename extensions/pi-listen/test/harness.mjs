/**
 * Standalone test harness for pi-listen.
 *
 *   node test/harness.mjs
 *
 * Fakes a minimal ExtensionAPI so the extension can be exercised without
 * starting a real pi session. Requires Node >= 23.6 (native TS type stripping).
 */
import { readFileSync, rmSync } from "node:fs";
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

const expectedTools = ["listen_start", "listen_status", "listen_output", "listen_stop"];
for (const name of expectedTools) {
	if (!tools.has(name)) throw new Error(`missing tool: ${name}`);
}
const expectedCommands = ["listen", "listen-stop", "listen-clear"];
for (const name of expectedCommands) {
	if (!commands.has(name)) throw new Error(`missing command: ${name}`);
}
if (tools.get("listen_start").parameters.properties.times) {
	throw new Error("listen_start must not expose a times parameter");
}
console.log("✓ tools and commands registered (no times parameter)");

// The listener-vs-one-shot logic must be stated in the system prompt.
const promptHandler = handlers.get("before_agent_start")?.[0];
if (!promptHandler) throw new Error("missing before_agent_start handler");
const prompt = await promptHandler({ systemPrompt: "BASE" }, ctx);
const promptText = String(prompt?.systemPrompt ?? "");
for (const needle of ["Background listeners (pi-listen)", "looping version of `bg_start`", "coalesces", "listen_stop"]) {
	if (!promptText.includes(needle)) throw new Error(`system prompt missing "${needle}"`);
}
console.log("✓ system prompt explains listen_start as the looping version of bg_start");

// 1. Continuous loop while idle: output is delivered and the command restarts.
const beforeLoop = userMessages.length;
await tools.get("listen_start").execute(
	"t1",
	{ command: "n=$(cat /tmp/pi-listen-counter 2>/dev/null || echo 0); n=$((n+1)); echo $n > /tmp/pi-listen-counter; echo LOOP_$n; sleep 0.2", label: "loop" },
	undefined,
	undefined,
	ctx,
);
await sleep(1_100);
const loopMsgs = userMessages.slice(beforeLoop).map((message) => String(message.content));
if (loopMsgs.length < 1) throw new Error("expected at least one listener notification");
const lastLoop = loopMsgs.at(-1);
for (const needle of ["[pi listen notification]", "listen-1", "LOOP_", "restarted automatically", "log file:"]) {
	if (!lastLoop.includes(needle)) throw new Error(`listener notification missing "${needle}":\n${lastLoop}`);
}
const loopStatus = await tools.get("listen_status").execute("t2", { id: "listen-1" }, undefined, undefined, ctx);
if (!loopStatus.content[0].text.includes("running")) throw new Error(`listener should be running:\n${loopStatus.content[0].text}`);
const loopOutput = await tools.get("listen_output").execute("t3", { id: "listen-1", lines: 20 }, undefined, undefined, ctx);
if (!loopOutput.content[0].text.includes("LOOP_")) throw new Error("listen_output missing current output");
console.log("✓ listener loops, notifies, status/output work");

// Verify the log contains every run, not just the latest notification.
const logPath = lastLoop.match(/log file: (.+)/)?.[1]?.trim();
if (!logPath) throw new Error("notification missing log path");
const log = readFileSync(logPath, "utf8");
for (const needle of ["=== run 1 started", "=== run 2 started", "LOOP_"]) {
	if (!log.includes(needle)) throw new Error(`log missing "${needle}"`);
}
console.log("✓ full log keeps every run");

// Stop the first listener before the coalescing test.
await tools.get("listen_stop").execute("t4", { id: "listen-1" }, undefined, undefined, ctx);
await sleep(400);

// 2. Busy agent: many runs collapse into one notification with the latest output.
idle = false;
const beforeBusy = userMessages.length;
await tools.get("listen_start").execute(
	"t5",
	{ command: "n=$(cat /tmp/pi-listen-busy 2>/dev/null || echo 0); n=$((n+1)); echo $n > /tmp/pi-listen-busy; echo BUSY_$n; sleep 0.03", label: "busy" },
	undefined,
	undefined,
	ctx,
);
await sleep(1_200);
if (userMessages.length !== beforeBusy) throw new Error("busy listener notification should wait for agent_settled");
const busyStatus = await tools.get("listen_status").execute("t6", { id: "listen-2" }, undefined, undefined, ctx);
if (!busyStatus.content[0].text.includes("runs:")) throw new Error("busy listener status missing run count");
if (!/run [2-9]|[1-9][0-9]+/.test(busyStatus.content[0].text)) throw new Error("busy listener did not loop while agent was busy");
idle = true;
await emit("agent_settled", {}, ctx);
await sleep(80);
const busyMsgs = userMessages.slice(beforeBusy);
if (busyMsgs.length !== 1) throw new Error(`busy runs should coalesce into 1 message, got ${busyMsgs.length}`);
const busyText = String(busyMsgs[0].content);
for (const needle of ["runs since the last notification", "BUSY_", "Only the latest run's output is shown", "log file:", "restarted automatically"]) {
	if (!busyText.includes(needle)) throw new Error(`coalesced message missing "${needle}":\n${busyText}`);
}
console.log("✓ busy runs coalesce into one message with latest output and run count");

// 3. listen_stop prevents any further restart.
const stopResult = await tools.get("listen_stop").execute("t7", { id: "listen-2" }, undefined, undefined, ctx);
if (!stopResult.content[0].text.includes("will not restart")) throw new Error("listen_stop did not report stopping");
await sleep(500);
const stoppedStatus = await tools.get("listen_status").execute("t8", { id: "listen-2" }, undefined, undefined, ctx);
if (!stoppedStatus.content[0].text.includes("stopped")) throw new Error(`listener not stopped:\n${stoppedStatus.content[0].text}`);
const runsAtStop = stoppedStatus.content[0].text.match(/runs: (\d+)/)?.[1];
await sleep(600);
const stillStopped = await tools.get("listen_status").execute("t9", { id: "listen-2" }, undefined, undefined, ctx);
const runsLater = stillStopped.content[0].text.match(/runs: (\d+)/)?.[1];
if (runsAtStop !== runsLater) throw new Error(`listener restarted after stop (${runsAtStop} -> ${runsLater})`);
if (!stillStopped.content[0].text.includes("stopped")) throw new Error("listener status changed after stop");
console.log("✓ listen_stop prevents restart");

// 4. Per-run timeout kills the current run and restarts the loop.
const beforeTimeout = userMessages.length;
await tools.get("listen_start").execute(
	"t10",
	{ command: "echo TICK; sleep 30", label: "timeout", timeout: 0.3 },
	undefined,
	undefined,
	ctx,
);
await sleep(1_300);
const timeoutMsgs = userMessages.slice(beforeTimeout).map((message) => String(message.content));
if (!timeoutMsgs.some((text) => text.includes("timeout") && text.includes("restarted"))) {
	throw new Error(`timeout run did not restart:\n${timeoutMsgs.join("\n---\n")}`);
}
const timeoutStatus = await tools.get("listen_status").execute("t11", { id: "listen-3" }, undefined, undefined, ctx);
if (!timeoutStatus.content[0].text.includes("running")) throw new Error("listener did not restart after timeout");
await tools.get("listen_stop").execute("t12", { id: "listen-3" }, undefined, undefined, ctx);
await sleep(400);
console.log("✓ timeout kills the current run and restarts the listener");

// 5. ANSI escapes stripped, multi-byte UTF-8 preserved.
const beforeAnsi = userMessages.length;
await tools.get("listen_start").execute("t13", { command: "printf '\\033[31m彩色\\033[0m\\n'; sleep 0.5", label: "ansi" }, undefined, undefined, ctx);
await sleep(900);
const ansiMsgs = userMessages.slice(beforeAnsi).map((message) => String(message.content));
const ansiText = ansiMsgs.join("\n");
if (!ansiText.includes("彩色")) throw new Error("UTF-8 output lost");
if (ansiText.includes("\u001b[")) throw new Error("ANSI escape leaked into notification");
await tools.get("listen_stop").execute("t14", { id: "listen-4" }, undefined, undefined, ctx);
await sleep(300);
console.log("✓ ANSI stripped, UTF-8 preserved");

// 6. Widget shows running listeners.
await tools.get("listen_start").execute("t15", { command: "sleep 30", label: "widget" }, undefined, undefined, ctx);
await sleep(50);
if (!(widgets.get("listen-jobs") ?? []).some((line) => line.includes("listen-5"))) {
	throw new Error("widget missing running listener");
}
console.log("✓ widget lists running listeners");

// 7. Shutdown kills running listeners and clears state.
await emit("session_shutdown", { reason: "quit" }, ctx);
const after = await tools.get("listen_status").execute("t16", {}, undefined, undefined, ctx);
if (!after.content[0].text.includes("No listeners")) throw new Error("listeners not cleared on shutdown");
console.log("✓ session_shutdown cleans up");

for (const file of ["/tmp/pi-listen-counter", "/tmp/pi-listen-busy"]) rmSync(file, { force: true });
console.log("\nAll checks passed.");
process.exit(0);
