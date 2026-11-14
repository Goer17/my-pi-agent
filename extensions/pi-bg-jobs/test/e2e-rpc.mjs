/**
 * End-to-end test with a real pi process in RPC mode.
 *
 *   node test/e2e-rpc.mjs
 *
 * Scenario (matches the motivating use case):
 *   1. Ask the agent to run `sleep 4; echo MAIL_ARRIVED` via bg_start.
 *   2. The agent ends its turn (idle conversation).
 *   3. 4s later the job exits; pi must inject its output as a user message
 *      and start a new agent turn.
 *
 * Requires a configured pi model (uses the default provider/model).
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const PROMPT = [
	"You MUST use the bg_start tool exactly once with this exact command:",
	"    sleep 4; echo MAIL_ARRIVED; echo SUBJECT: hello",
	'Give it the label "mail-listener".',
	"After the tool returns, reply with exactly: FIRST_DONE",
	"Do not wait for the job, do not poll, and end your turn immediately.",
].join("\n");

const child = spawn("pi", ["--mode", "rpc", "--no-session", "-e", join(root, "index.ts"), "--thinking", "off", "--tools", "bg_start"], {
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

/** Resolve with the first matching event at or after `fromIndex` (already-received events included). */
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

function send(command) {
	child.stdin.write(`${JSON.stringify(command)}\n`);
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
	event.type === "message_end" && event.message?.role === "user" && textOf(event.message).includes("background job notification");

let exitCode;
try {
	send({ id: "p1", type: "prompt", message: PROMPT });
	await waitFor((event) => event.type === "response" && event.id === "p1" && event.success, 30_000, "prompt accepted");
	console.log("✓ prompt accepted");

	// The notification may arrive before or after the first run settles (the
	// agent may still be streaming when the job exits), so search the whole
	// stream and only then require a settle after it.
	const notification = await waitFor(isNotification, 120_000, "background job notification", 0);
	const notificationIndex = events.indexOf(notification);
	const notificationText = textOf(notification.message);
	if (!notificationText.includes("MAIL_ARRIVED")) throw new Error("notification missing job stdout");
	if (!notificationText.includes("exit code 0")) throw new Error("notification missing exit code");
	if (!notificationText.includes("mail-listener")) throw new Error("notification missing label");
	console.log("✓ job exit injected as a user message");

	await waitFor((event) => event.type === "agent_settled", 180_000, "agent to settle after the notification", notificationIndex + 1);
	console.log("✓ agent settled after processing the notification");

	const assistantsAfter = events.filter(
		(event, index) =>
			index > notificationIndex && event.type === "message_end" && event.message?.role === "assistant" && textOf(event.message).trim().length > 0,
	);
	if (assistantsAfter.length === 0) throw new Error("agent did not respond after the notification");
	console.log("✓ agent woke up and produced a new assistant message");
	console.log(`  assistant reply: ${textOf(assistantsAfter.at(-1).message).replace(/\s+/g, " ").slice(0, 180)}`);

	send({ id: "m1", type: "get_messages" });
	const messages = await waitFor((event) => event.type === "response" && event.id === "m1" && event.success, 30_000, "get_messages");
	const all = messages.data?.messages ?? [];
	const userCount = all.filter((message) => message.role === "user").length;
	if (userCount < 2) throw new Error(`expected an injected user message, got roles: ${all.map((m) => m.role).join(",")}`);
	console.log("✓ transcript contains the injected user message");
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
}

if (exitCode) {
	console.log("\nE2E checks FAILED.");
	process.exit(1);
}
console.log("\nE2E checks passed.");