/**
 * End-to-end test with a real pi process in RPC mode.
 *
 *   node test/e2e-rpc.mjs
 *
 * Scenario:
 *   1. Ask the agent to run a listener that prints MAIL_1 and sleeps 3s.
 *   2. The agent ends its turn.
 *   3. The listener exits; pi injects its output as a user message and the
 *      listener restarts automatically.
 *
 * Requires a configured pi model (uses the default provider/model).
 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const counterFile = join(tmpdir(), `pi-listen-e2e-${Date.now()}.txt`);
const command = `n=$(cat ${counterFile} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counterFile}; echo MAIL_$n; sleep 3`;

const PROMPT = [
	"You MUST use the listen_start tool exactly once with this exact command:",
	`    ${command}`,
	'Give it the label "mail-listener".',
	"After the tool returns, reply with exactly: FIRST_DONE",
	"Do not wait for the listener, do not poll, do not stop it, and end your turn immediately.",
].join("\n");

const child = spawn("pi", ["--mode", "rpc", "--no-session", "-e", join(root, "index.ts"), "--thinking", "off", "--tools", "listen_start"], {
	cwd: root,
	stdio: ["pipe", "pipe", "pipe"],
});

let stdoutBuffer = "";
let stderrText = "";
const events = [];
const waiters = [];

child.stderr.on("data", (chunk) => {
	stderrText += chunk.toString();
});

child.stdout.on("data", (chunk) => {
	stdoutBuffer += chunk.toString();
	for (;;) {
		const newline = stdoutBuffer.indexOf("\n");
		if (newline < 0) break;
		const line = stdoutBuffer.slice(0, newline);
		stdoutBuffer = stdoutBuffer.slice(newline + 1);
		if (!line.trim()) continue;
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			continue;
		}
		const index = events.length;
		events.push(message);
		for (let i = waiters.length - 1; i >= 0; i--) {
			const waiter = waiters[i];
			if (index < waiter.fromIndex) continue;
			let matches = false;
			try {
				matches = waiter.predicate(message, index);
			} catch {
				matches = false;
			}
			if (matches) {
				waiters.splice(i, 1);
				clearTimeout(waiter.timer);
				waiter.resolve(message);
			}
		}
	}
});

function waitFor(predicate, timeoutMs, label, fromIndex = 0) {
	for (let index = fromIndex; index < events.length; index++) {
		if (predicate(events[index], index)) return Promise.resolve(events[index]);
	}
	return new Promise((resolve, reject) => {
		const waiter = { predicate, fromIndex, resolve, timer: undefined };
		waiter.timer = setTimeout(() => {
			const index = waiters.indexOf(waiter);
			if (index >= 0) waiters.splice(index, 1);
			reject(new Error(`timeout waiting for ${label}\n${dump()}\nstderr:\n${stderrText}`));
		}, timeoutMs);
		waiters.push(waiter);
	});
}

function send(commandJson) {
	child.stdin.write(`${JSON.stringify(commandJson)}\n`);
}

const textOf = (message) => {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content.map((part) => (part.type === "text" ? part.text : `<${part.type}>`)).join("\n");
	}
	return "";
};

function dump() {
	const lines = ["--- transcript ---"];
	for (const event of events) {
		if (event.type === "message_end") {
			lines.push(`[${event.message?.role}] ${textOf(event.message).replace(/\s+/g, " ").slice(0, 240)}`);
		} else if (event.type === "agent_settled" || event.type === "agent_start" || event.type === "extension_error") {
			lines.push(`[event] ${event.type}${event.type === "extension_error" ? `: ${JSON.stringify(event)}` : ""}`);
		}
	}
	return lines.join("\n");
}

const isNotification = (event) =>
	event.type === "message_end" && event.message?.role === "user" && textOf(event.message).includes("pi listen notification");

let exitCode;
try {
	send({ id: "p1", type: "prompt", message: PROMPT });
	await waitFor((event) => event.type === "response" && event.id === "p1" && event.success, 30_000, "prompt accepted");
	console.log("✓ prompt accepted");

	const notification = await waitFor(isNotification, 120_000, "listener notification", 0);
	const notificationIndex = events.indexOf(notification);
	const notificationText = textOf(notification.message);
	if (!notificationText.includes("MAIL_1")) throw new Error("notification missing listener stdout");
	if (!notificationText.includes("run 1")) throw new Error("notification missing run number");
	if (!notificationText.includes("restarted")) throw new Error("notification missing automatic restart");
	if (!notificationText.includes("log file:")) throw new Error("notification missing log path");
	console.log("✓ listener exit injected as a user message and restarted");

	await waitFor((event) => event.type === "agent_settled", 180_000, "agent to settle after the notification", notificationIndex + 1);
	console.log("✓ agent settled after processing the notification");

	const assistantsAfter = events.filter(
		(event, index) =>
			index > notificationIndex && event.type === "message_end" && event.message?.role === "assistant" && textOf(event.message).trim().length > 0,
	);
	if (assistantsAfter.length === 0) throw new Error("agent did not respond after the notification");
	console.log("✓ agent woke up and produced a new assistant message");
	console.log(`  assistant reply: ${textOf(assistantsAfter.at(-1).message).replace(/\s+/g, " ").slice(0, 180)}`);
} catch (error) {
	console.error(`\n${error.message}`);
	exitCode = 1;
} finally {
	child.stdin.end();
	await new Promise((resolve) => {
		child.once("exit", resolve);
		setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				// ignore
			}
		}, 5_000);
	});
	rmSync(counterFile, { force: true });
}

if (exitCode) {
	console.log("\nE2E checks FAILED.");
	process.exit(1);
}
console.log("\nE2E checks passed.");
