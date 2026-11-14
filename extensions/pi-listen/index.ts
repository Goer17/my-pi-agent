/**
 * pi-listen
 *
 * Continuously run a shell command in the background. This is the looping
 * version of pi-bg-jobs' bg_start: whenever the command exits (with any exit
 * code), its captured stdout/stderr is delivered to the agent as a user
 * message and the command is started again immediately. The loop runs until
 * the agent calls listen_stop (or the session shuts down).
 *
 * Typical use: mail/IM waiters, queue consumers, watchers, polling commands.
 *
 * Tools:  listen_start, listen_status, listen_output, listen_stop
 * Commands: /listen, /listen-stop <id> [signal], /listen-clear
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_BUFFER_CHARS = 200_000;
const MAX_MESSAGE_LINES = 120;
const MAX_MESSAGE_CHARS = 12_000;
const MAX_FINISHED_JOBS = 20;
const NOTIFY_DEBOUNCE_MS = 250;
const DEFAULT_WAIT_SECONDS = 60;
const MAX_WAIT_SECONDS = 600;

type JobStatus = "running" | "exited" | "killed" | "failed";

interface Job {
	id: string;
	label: string;
	command: string;
	cwd: string;
	status: JobStatus;
	/** Number of the run currently in progress (1-based), or of the last run once finished. */
	run: number;
	/** How many runs have ended so far. */
	runsCompleted: number;
	startedAt: number;
	runStartedAt: number;
	endedAt?: number;
	pid?: number;
	/** Result of the most recent run (including the last, final one). */
	lastRun?: RunResult;
	exitCode?: number | null;
	signal?: NodeJS.Signals | null;
	timedOutLastRun: boolean;
	/** Capped tail of the current run's stdout+stderr, ANSI escapes stripped. */
	output: string;
	outputChars: number;
	truncated: boolean;
	logFile: string;
	logStream?: WriteStream;
	child?: ChildProcess;
	timeout?: NodeJS.Timeout;
	/** Per-run timeout in seconds, if any. */
	timeoutSeconds?: number;
	runActive: boolean;
	spawnFailed: boolean;
	killReason?: "user" | "shutdown";
	silent: boolean;
	waiters: Array<(result: RunResult) => void>;
}

interface PendingNotification {
	job: Job;
	runs: number;
	latest: RunResult;
}

interface RunResult {
	runNumber: number;
	output: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	durationMs: number;
	/** The loop restarted after this run. */
	restarted: boolean;
	/** Status of the job after this run. */
	jobStatus: JobStatus;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Matches ANSI escape sequences (CSI, OSC, etc.) so transcripts stay clean.
const ANSI_RE =
	// eslint-disable-next-line no-control-regex
	/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

function formatDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rest = s % 60;
	if (m < 60) return rest ? `${m}m ${rest}s` : `${m}m`;
	const h = Math.floor(m / 60);
	const rm = m % 60;
	return rm ? `${h}h ${rm}m` : `${h}h`;
}

function truncate(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}

function logDir(): string {
	const dir = join(tmpdir(), "pi-listen");
	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		// Fall back to the system temp dir itself; the log file name is unique.
	}
	return dir;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

const LISTEN_SYSTEM_PROMPT = `
## Background listeners (pi-listen)

\`listen_start\` is the looping version of \`bg_start\`:
1. Run the command once via \`bash -lc\`.
2. When it exits (any exit code), deliver its captured stdout/stderr to you as a user message, write the full output to the job's log file, and start the command again immediately.
3. Repeat until \`listen_stop\` or session shutdown.

Use \`listen_start\` for recurring events (mail/IM waiters, queue consumers, watchers, polling commands). Use \`bg_start\` for a process that should run exactly once.

If several runs finish while you are busy, pi-listen coalesces them into one notification with the number of runs and the latest output tail; the log file contains every run. Do not poll or sleep-wait for a listener; wait for the notification. Cancel a listener with \`listen_stop <id>\`.
`;

function runEndText(result: Pick<RunResult, "timedOut" | "exitCode" | "signal">): string {
	if (result.timedOut) return result.signal ? `timeout (${result.signal})` : "timeout";
	if (result.exitCode !== undefined && result.exitCode !== null) return `exit code ${result.exitCode}`;
	if (result.signal) return `signal ${result.signal}`;
	return "process ended";
}

function tailOutput(text: string, maxLines: number, maxChars: number): { body: string; clipped: boolean } {
	const lines = text.split("\n");
	let clipped = false;
	let selected = lines;
	if (lines.length > maxLines) {
		selected = lines.slice(-maxLines);
		clipped = true;
	}
	let body = selected.join("\n").replace(/\s+$/, "");
	if (body.length > maxChars) {
		body = body.slice(-maxChars);
		clipped = true;
	}
	return { body, clipped };
}

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const jobs = new Map<string, Job>();
	let seq = 0;
	let lastCtx: ExtensionContext | undefined;
	let agentBusy = false;
	let sessionActive = false;
	let widgetTimer: NodeJS.Timeout | undefined;
	let flushTimer: NodeJS.Timeout | undefined;
	let pending = new Map<string, PendingNotification>();
	let exitHookInstalled = false;
	/** Last widget payload, to avoid re-sending identical updates every second. */
	let widgetKey: string | undefined;

	// -- state helpers ------------------------------------------------------

	function pushOutput(job: Job, chunk: string) {
		job.outputChars += chunk.length;
		job.output += chunk;
		if (job.output.length > MAX_BUFFER_CHARS) {
			job.output = job.output.slice(-MAX_BUFFER_CHARS);
			job.truncated = true;
		}
	}

	function pruneJobs() {
		const finished = [...jobs.values()].filter((job) => job.status !== "running");
		if (finished.length <= MAX_FINISHED_JOBS) return;
		for (const job of finished.slice(0, finished.length - MAX_FINISHED_JOBS)) {
			jobs.delete(job.id);
		}
	}

	function ensureWidgetTimer() {
		if (widgetTimer) return;
		widgetTimer = setInterval(updateWidget, 1_000);
		widgetTimer.unref?.();
	}

	function updateWidget() {
		if (!lastCtx) return;
		const running = [...jobs.values()].filter((job) => job.status === "running");
		if (running.length === 0 && widgetTimer) {
			clearInterval(widgetTimer);
			widgetTimer = undefined;
		}
		const lines = running.map((job) => {
			const label = job.label ? ` "${job.label}"` : "";
			return `● ${job.id}${label} · run ${job.run} · ${formatDuration(Date.now() - job.startedAt)} · ${truncate(job.command, 50)}`;
		});
		const next = lines.length > 0 ? lines : undefined;
		const key = next?.join("\n");
		if (key === widgetKey) return;
		widgetKey = key;
		try {
			lastCtx.ui.setWidget("listen-jobs", next);
		} catch {
			// UI is not always available (print/JSON mode, teardown, etc.).
		}
	}

	function isAgentBusy(): boolean {
		try {
			if (lastCtx) return !lastCtx.isIdle();
		} catch {
			// Fall through to the event-tracked flag.
		}
		return agentBusy;
	}

	function installExitHook() {
		if (exitHookInstalled) return;
		exitHookInstalled = true;
		process.once("exit", () => {
			for (const job of jobs.values()) {
				if (job.runActive) {
					try {
						job.child?.kill("SIGKILL");
					} catch {
						// best effort
					}
				}
			}
		});
	}

	// -- notification ------------------------------------------------------

	function buildRunMessage(job: Job, result: RunResult, pendingRuns: number): string {
		const label = job.label ? ` "${job.label}"` : "";

		let headline: string;
		if (result.jobStatus === "killed") {
			const why = job.killReason === "shutdown" ? "stopped on session shutdown" : "stopped";
			const sig = result.signal ? ` (${result.signal})` : "";
			headline = `Listener ${job.id}${label} ${why}${sig} after run ${result.runNumber}.`;
		} else if (result.jobStatus === "failed") {
			headline = `Listener ${job.id}${label} failed to start; it has stopped.`;
		} else if (pendingRuns > 1) {
			headline = `Listener ${job.id}${label} completed ${pendingRuns} runs since the last notification; latest run ${result.runNumber} finished with ${runEndText(result)} and restarted.`;
		} else {
			headline = `Listener ${job.id}${label} run ${result.runNumber} finished with ${runEndText(result)} and restarted.`;
		}

		const parts = [
			`[pi listen notification] ${headline}`,
			`command: ${job.command}`,
			`cwd: ${job.cwd}`,
			`run: ${result.runNumber} (${job.runsCompleted} completed since the listener started)`,
			`duration: ${formatDuration(result.durationMs)}`,
			`log file: ${job.logFile}`,
		];
		if (pendingRuns > 1) {
			parts.push(`Only the latest run's output is shown; all ${pendingRuns} runs are in the log file.`);
		}
		parts.push("");

		const t = tailOutput(result.output, MAX_MESSAGE_LINES, MAX_MESSAGE_CHARS);
		if (t.body.trim().length === 0) {
			parts.push("output: (none)");
		} else {
			parts.push(
				`output${t.clipped ? ` (tail, truncated to last ${MAX_MESSAGE_LINES} lines)` : ""}:`,
				"----- output -----",
				t.body,
				"----- end output -----",
			);
		}

		if (result.restarted) {
			parts.push(
				"",
				`The listener restarted automatically and is now on run ${result.runNumber + 1}. Stop it with listen_stop ${job.id}.`,
			);
		} else if (result.jobStatus === "killed") {
			parts.push("", "The listener was stopped and will not restart.");
		} else if (result.jobStatus === "failed") {
			parts.push("", "The listener could not start and has stopped.");
		}

		const stillRunning = [...jobs.values()].filter((other) => other.status === "running" && other.id !== job.id);
		if (stillRunning.length > 0) {
			parts.push("", `still listening: ${stillRunning.map((other) => `${other.id}${other.label ? ` "${other.label}"` : ""}`).join(", ")}`);
		}

		parts.push("", "This is an automatic notification, not a user reply. Continue the task using the output above.");
		return parts.join("\n");
	}

	function flushNotifications(force = false) {
		flushTimer = undefined;
		if (pending.size === 0 || !sessionActive) return;
		// While the agent is busy, keep notifications here instead of handing
		// them to pi's follow-up queue: Escape restores that queue into the
		// editor as text. agent_settled (including after an Escape abort) flushes
		// them as a normal user message. Repeated runs of one listener collapse
		// into a single notification carrying the latest output and a run count.
		if (!force && isAgentBusy()) return;

		const batch = [...pending.values()];
		pending.clear();
		const text = batch.map(({ job, runs, latest }) => buildRunMessage(job, latest, runs)).join("\n\n");

		// In headless modes (print/RPC) also echo the notification to stderr so
		// the operator sees the output even before the agent reacts. Avoid TUI
		// (would corrupt the alternate screen) and JSON (machine-read stdout).
		try {
			if (lastCtx?.mode !== "tui" && lastCtx?.mode !== "json") process.stderr.write(`${text}\n`);
		} catch {
			// ignore
		}

		try {
			pi.sendUserMessage(text);
		} catch (error) {
			// Race: the agent may have started streaming between the check and the
			// call. Merge the batch back and retry on the next agent_settled.
			for (const item of batch) {
				const existing = pending.get(item.job.id);
				if (existing) {
					existing.runs += item.runs;
					existing.latest = item.latest;
				} else {
					pending.set(item.job.id, item);
				}
			}
			try {
				lastCtx?.ui.notify(`Failed to deliver listener output: ${(error as Error).message}`, "error");
			} catch {
				// give up
			}
		}
	}

	function queueNotification(job: Job, result: RunResult) {
		if (job.silent || !sessionActive) return;
		const existing = pending.get(job.id);
		if (existing) {
			existing.runs += 1;
			existing.latest = result;
		} else {
			pending.set(job.id, { job, runs: 1, latest: result });
		}
		if (flushTimer) return;
		flushTimer = setTimeout(() => flushNotifications(), NOTIFY_DEBOUNCE_MS);
		flushTimer.unref?.();
	}

	// -- job lifecycle -----------------------------------------------------

	function endRun(job: Job, runNumber: number, code: number | null, signal: NodeJS.Signals | null) {
		// Ignore a late close/exit from a previous run once a new run started.
		if (job.run !== runNumber || !job.runActive) return;
		job.runActive = false;
		if (job.timeout) {
			clearTimeout(job.timeout);
			job.timeout = undefined;
		}

		const timedOut = job.timedOutLastRun;
		const stopped = job.killReason === "user" || job.killReason === "shutdown";
		const failed = job.spawnFailed;
		// pi-listen always restarts unless the agent stopped it or it failed to start.
		const restarted = !stopped && !failed;

		job.exitCode = code;
		job.signal = signal;
		job.runsCompleted = runNumber;

		const jobStatus: JobStatus = restarted ? "running" : stopped ? "killed" : failed ? "failed" : "exited";
		const result: RunResult = {
			runNumber,
			output: job.output,
			exitCode: code,
			signal,
			timedOut,
			durationMs: Date.now() - job.runStartedAt,
			restarted,
			jobStatus,
		};
		job.lastRun = result;

		if (restarted) {
			try {
				job.logStream?.write(
					`\n[pi] run ${runNumber} ended (${runEndText(result)}); restarting as run ${runNumber + 1}\n`,
				);
			} catch {
				// ignore
			}
			job.run = runNumber + 1;
			spawnRun(job);
		} else {
			job.status = jobStatus;
			job.endedAt = Date.now();
			try {
				job.logStream?.end();
			} catch {
				// ignore
			}
			job.logStream = undefined;
		}

		const waiters = job.waiters.splice(0);
		for (const wake of waiters) {
			try {
				wake(result);
			} catch {
				// ignore
			}
		}

		updateWidget();
		queueNotification(job, result);

		// A toast for every iteration would be noise for fast listeners; notify
		// only when the loop actually stops (stopped or failed to start).
		if (!job.silent && sessionActive && !restarted) {
			try {
				lastCtx?.ui.notify(
					`${job.id}${job.label ? ` "${job.label}"` : ""} ${result.jobStatus === "failed" ? "failed to start" : "stopped"} after run ${runNumber}`,
					result.jobStatus === "failed" ? "warning" : "info",
				);
			} catch {
				// no UI
			}
		}

		pruneJobs();
	}

	function spawnRun(job: Job) {
		job.runStartedAt = Date.now();
		job.runActive = true;
		job.output = "";
		job.outputChars = 0;
		job.truncated = false;
		job.timedOutLastRun = false;
		job.exitCode = undefined;
		job.signal = undefined;
		job.spawnFailed = false;

		try {
			job.logStream?.write(`\n[pi] === run ${job.run} started ${new Date().toISOString()} ===\n`);
		} catch {
			// ignore
		}

		const shell = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
		const child = spawn(shell, ["-lc", job.command], {
			cwd: job.cwd,
			env: {
				...process.env,
				PI_LISTEN_JOB_ID: job.id,
				PI_LISTEN_JOB_LABEL: job.label,
				PI_LISTEN_JOB_RUN: String(job.run),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		job.child = child;
		job.pid = child.pid;
		const runNumber = job.run;

		const onText = (raw: string) => {
			if (!raw) return;
			try {
				job.logStream?.write(raw);
			} catch {
				// ignore
			}
			pushOutput(job, stripAnsi(raw));
		};
		// StringDecoder keeps multi-byte characters intact across chunk boundaries.
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");
		child.stdout?.on("data", (chunk: Buffer) => onText(stdoutDecoder.write(chunk)));
		child.stderr?.on("data", (chunk: Buffer) => onText(stderrDecoder.write(chunk)));

		const timeoutSeconds = job.timeoutSeconds;
		if (timeoutSeconds && timeoutSeconds > 0) {
			job.timeout = setTimeout(() => {
				if (job.run !== runNumber || !job.runActive) return;
				job.timedOutLastRun = true;
				pushOutput(job, `\n[pi] timeout of ${timeoutSeconds}s reached for run ${runNumber}, sending SIGTERM and restarting\n`);
				try {
					child.kill("SIGTERM");
				} catch {
					// ignore
				}
				setTimeout(() => {
					if (job.run === runNumber && job.runActive) {
						try {
							child.kill("SIGKILL");
						} catch {
							// ignore
						}
					}
				}, 5_000).unref?.();
			}, timeoutSeconds * 1000);
			job.timeout.unref?.();
		}

		child.on("error", (error) => {
			job.spawnFailed = true;
			pushOutput(job, `\n[pi] failed to start: ${error.message}\n`);
			endRun(job, runNumber, null, null);
		});

		let exitTimer: NodeJS.Timeout | undefined;
		child.on("close", (code, signal) => {
			if (exitTimer) clearTimeout(exitTimer);
			onText(stdoutDecoder.end());
			onText(stderrDecoder.end());
			endRun(job, runNumber, code, signal);
		});

		// 'close' waits for every holder of the stdio pipes. If the process left
		// a grandchild behind that inherited the pipes, don't hang the
		// notification forever: finalize shortly after 'exit' instead, using the
		// output captured so far. Usually 'close' wins this race.
		child.on("exit", (code, signal) => {
			exitTimer = setTimeout(() => {
				try {
					onText(stdoutDecoder.end());
					onText(stderrDecoder.end());
				} catch {
					// ignore
				}
				endRun(job, runNumber, code, signal);
			}, 500);
			exitTimer.unref?.();
		});

		updateWidget();
		ensureWidgetTimer();
	}

	function startJob(
		command: string,
		options: { label?: string; cwd: string; timeoutSeconds?: number },
	): Job {
		seq += 1;
		const id = `listen-${seq}`;
		const logFile = join(logDir(), `${id}-${Date.now()}.log`);
		const job: Job = {
			id,
			label: options.label?.trim() ?? "",
			command,
			cwd: options.cwd,
			status: "running",
			run: 1,
			runsCompleted: 0,
			startedAt: Date.now(),
			runStartedAt: 0,
			timedOutLastRun: false,
			output: "",
			outputChars: 0,
			truncated: false,
			logFile,
			runActive: false,
			spawnFailed: false,
			silent: false,
			waiters: [],
			timeoutSeconds: options.timeoutSeconds,
		};
		jobs.set(id, job);
		installExitHook();

		const logStream = createWriteStream(logFile, { flags: "a" });
		logStream.on("error", () => {
			// Never let logging break the job.
		});
		job.logStream = logStream;
		try {
			logStream.write(`[pi] ${new Date().toISOString()} listener ${id}${job.label ? ` "${job.label}"` : ""}: ${command}\n`);
			logStream.write(`[pi] loop mode: restart after every exit until listen_stop\n`);
		} catch {
			// ignore
		}

		spawnRun(job);
		return job;
	}

	function waitForJob(job: Job, timeoutMs: number, signal?: AbortSignal): Promise<RunResult | null> {
		if (job.status !== "running") return Promise.resolve(job.lastRun ?? null);
		return new Promise((resolveWait) => {
			let done = false;
			let timer: NodeJS.Timeout | undefined;
			const finish = (result: RunResult | null) => {
				if (done) return;
				done = true;
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				const index = job.waiters.indexOf(onDone);
				if (index >= 0) job.waiters.splice(index, 1);
				resolveWait(result);
			};
			const onDone = (result: RunResult) => finish(result);
			const onAbort = () => finish(null);
			job.waiters.push(onDone);
			if (timeoutMs > 0) {
				timer = setTimeout(() => finish(null), timeoutMs);
				timer.unref?.();
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) finish(null);
		});
	}

	async function waitForAll(list: Job[], timeoutMs: number) {
		await Promise.all(list.map((job) => (job.status === "running" ? waitForJob(job, timeoutMs) : Promise.resolve(null))));
	}

	// -- formatting --------------------------------------------------------

	function exitText(job: Job): string {
		if (job.status === "running") return "running";
		if (job.status === "failed") return "failed to start";
		if (job.status === "killed") {
			const why = job.killReason === "shutdown" ? "stopped on session shutdown" : "stopped";
			return job.signal ? `${why} (${job.signal})` : why;
		}
		if (job.timedOutLastRun) return job.signal ? `timeout (${job.signal})` : "timeout";
		if (job.exitCode !== undefined && job.exitCode !== null) return `exit code ${job.exitCode}`;
		if (job.signal) return `signal ${job.signal}`;
		return job.status;
	}

	function formatJobList(list: Job[]): string {
		if (list.length === 0) return "No listeners.";
		const runningCount = list.filter((job) => job.status === "running").length;
		const lines = [`Listeners (${runningCount} running / ${list.length} total):`];
		for (const job of list) {
			const marker = job.status === "running" ? "●" : "○";
			const label = job.label ? ` "${job.label}"` : "";
			const result =
				job.status === "running"
					? `running · run ${job.run} · ${formatDuration(Date.now() - job.startedAt)}`
					: `${exitText(job)} after ${formatDuration((job.endedAt ?? Date.now()) - job.startedAt)} (${job.runsCompleted} runs)`;
			lines.push(`${marker} ${job.id}${label} — ${result} — ${truncate(job.command, 70)}`);
		}
		return lines.join("\n");
	}

	function describeJob(job: Job): string {
		const status = job.status === "killed" ? "stopped" : job.status;
		const lines = [
			`${job.id}${job.label ? ` "${job.label}"` : ""} — ${status}`,
			`command: ${job.command}`,
			`cwd: ${job.cwd}`,
			`pid: ${job.pid ?? "unknown"}`,
			`started: ${new Date(job.startedAt).toISOString()}`,
		];
		lines.push(
			job.status === "running"
				? `runs: ${job.runsCompleted} finished, run ${job.run} in progress`
				: `runs: ${job.runsCompleted} finished (last run ${job.run})`,
		);
		if (job.status === "running") {
			lines.push(`elapsed: ${formatDuration(Date.now() - job.startedAt)} (current run ${formatDuration(Date.now() - job.runStartedAt)})`);
		} else {
			lines.push(`ended: ${new Date(job.endedAt ?? job.startedAt).toISOString()}`);
			lines.push(`total duration: ${formatDuration((job.endedAt ?? Date.now()) - job.startedAt)}`);
			lines.push(`result: ${exitText(job)}`);
		}
		lines.push(
			`output: ${job.outputChars} chars captured for the current/last run${job.truncated ? ` (in-memory buffer truncated to last ${MAX_BUFFER_CHARS} chars)` : ""}`,
			`log file: ${job.logFile}`,
		);
		return lines.join("\n");
	}

	function notFound(id: string): string {
		const ids = [...jobs.keys()];
		return ids.length === 0
			? `No listener with id "${id}". There are no listeners in this session.`
			: `No listener with id "${id}". Known listeners: ${ids.join(", ")}.`;
	}

	// -- events ------------------------------------------------------------

	pi.on("before_agent_start", async (event) => {
		if (event.systemPrompt.includes("## Background listeners (pi-listen)")) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${LISTEN_SYSTEM_PROMPT}` };
	});

	pi.on("session_start", async (_event, ctx) => {
		// Session-scoped state. Jobs from a previous session were killed in
		// session_shutdown; make sure nothing stale survives.
		lastCtx = ctx;
		agentBusy = false;
		sessionActive = true;
		pending.clear();
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = undefined;
		}
		for (const job of jobs.values()) {
			if (job.runActive) {
				job.silent = true;
				job.killReason = "shutdown";
				try {
					job.child?.kill("SIGTERM");
				} catch {
					// ignore
				}
			}
		}
		jobs.clear();
		if (widgetTimer) clearInterval(widgetTimer);
		widgetTimer = undefined;
		widgetKey = undefined;
		updateWidget();
	});

	pi.on("agent_start", async (_event, ctx) => {
		agentBusy = true;
		lastCtx = ctx;
	});

	pi.on("agent_end", async (_event, ctx) => {
		lastCtx = ctx;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		agentBusy = false;
		lastCtx = ctx;
		// Deliver anything that accumulated while the agent was busy. This also
		// runs after an Escape abort, so queued listener output is sent as a
		// user message instead of being restored into the editor.
		flushNotifications(true);
	});

	pi.on("session_shutdown", async () => {
		sessionActive = false;
		if (widgetTimer) {
			clearInterval(widgetTimer);
			widgetTimer = undefined;
		}
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = undefined;
		}
		pending.clear();

		const running = [...jobs.values()].filter((job) => job.status === "running");
		for (const job of running) {
			job.silent = true;
			job.killReason = "shutdown";
			try {
				job.child?.kill("SIGTERM");
			} catch {
				// ignore
			}
		}
		if (running.length > 0) {
			await waitForAll(running, 1_500);
			for (const job of running) {
				if (job.runActive) {
					try {
						job.child?.kill("SIGKILL");
					} catch {
						// ignore
					}
				}
			}
			await waitForAll(running, 500);
		}

		try {
			lastCtx?.ui.setWidget("listen-jobs", undefined);
		} catch {
			// no UI
		}
		widgetKey = undefined;
		jobs.clear();
	});

	// -- tools -------------------------------------------------------------

	pi.registerTool({
		name: "listen_start",
		label: "Start Listener",
		description:
			"Continuously run a shell command in the background. listen_start is the looping version of bg_start: the command runs, its captured stdout/stderr is delivered to you as a user message when it exits, and it starts again immediately. The loop runs until listen_stop. Use bg_start for a command that should run only once.",
		promptSnippet: "Continuously run a shell command in the background; each exit's output is delivered and the command restarts",
		promptGuidelines: [
			"listen_start is the looping version of bg_start: it runs the command, delivers its output when it exits, then runs it again until listen_stop. Use listen_start for recurring events (mail/IM waiters, watchers, queues, polling).",
			"Use bg_start instead of listen_start when the process should run exactly once.",
			"After listen_start, do not poll or sleep-wait; each run's output arrives automatically. If many runs finish while you are busy, one notification with the latest output tail and a run count is sent; the full log file is included.",
			"Use listen_stop to cancel a listener. listen_status and listen_output inspect it.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run via bash -lc; it is restarted after every exit" }),
			label: Type.Optional(Type.String({ description: "Short human-readable label shown in the UI and notifications" })),
			cwd: Type.Optional(Type.String({ description: "Working directory (defaults to the current cwd)" })),
			timeout: Type.Optional(
				Type.Number({
					description:
						"Optional per-run timeout in seconds; when it expires the current run is killed and the listener restarts (0 = none)",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const command = params.command?.trim();
			if (!command) return textResult("Error: command is required.");

			const cwd = params.cwd ? resolve(ctx.cwd, params.cwd) : ctx.cwd;
			if (!existsSync(cwd)) return textResult(`Error: working directory does not exist: ${cwd}`);

			const timeoutSeconds =
				params.timeout !== undefined && Number.isFinite(params.timeout) && params.timeout > 0 ? params.timeout : undefined;
			const job = startJob(command, { label: params.label, cwd, timeoutSeconds });

			return textResult(
				[
					`Started listener ${job.id}${job.label ? ` "${job.label}"` : ""} in the background (pid ${job.pid ?? "unknown"}).`,
					"It will restart automatically after every exit until listen_stop.",
					`command: ${command}`,
					`cwd: ${cwd}`,
					`log file: ${job.logFile}`,
					"",
					"Do not wait or poll. Each run's output will be sent to you automatically as a user message. If several runs finish while you are busy, they are coalesced into one notification with the latest output tail; the full log has every run.",
				].join("\n"),
				{ jobId: job.id, pid: job.pid, command, cwd, logFile: job.logFile },
			);
		},
	});

	pi.registerTool({
		name: "listen_status",
		label: "Listener Status",
		description:
			"List listeners, or show details for one listener. Running listeners show the current run and elapsed time; stopped listeners show the run count, duration, result and log path.",
		promptSnippet: "List listeners or inspect one listener's status",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Listener id (e.g. listen-1). Omit to list all listeners." })),
		}),
		async execute(_toolCallId, params) {
			if (params.id) {
				const job = jobs.get(params.id);
				if (!job) return textResult(notFound(params.id));
				return textResult(describeJob(job), { jobId: job.id, status: job.status, runs: job.runsCompleted });
			}
			return textResult(formatJobList([...jobs.values()]), { count: jobs.size });
		},
	});

	pi.registerTool({
		name: "listen_output",
		label: "Listener Output",
		description:
			"Read the captured stdout/stderr of a listener's current (or last) run. Shows the last N lines from the in-memory buffer; the full output of every run is always available in the listener's log file.",
		promptSnippet: "Read captured output of a listener",
		parameters: Type.Object({
			id: Type.String({ description: "Listener id (e.g. listen-1)" }),
			lines: Type.Optional(Type.Number({ description: "Number of trailing lines to return (default 100, max 2000)" })),
		}),
		async execute(_toolCallId, params) {
			const job = jobs.get(params.id);
			if (!job) return textResult(notFound(params.id));

			const count = clampInt(params.lines, 1, 2000, 100);
			const lines = job.output.split("\n");
			const body = lines.slice(-count).join("\n").replace(/\s+$/, "");
			const shown = Math.min(count, lines.length);
			const header = [
				`Output of ${job.id}${job.label ? ` "${job.label}"` : ""} run ${job.run} — ${job.status === "running" ? "running" : exitText(job)}`,
				`last ${shown} of ${lines.length} buffered lines${job.truncated ? ` (buffer truncated to last ${MAX_BUFFER_CHARS} chars)` : ""}`,
				`log file: ${job.logFile}`,
			].join("\n");

			return textResult([header, "", body.length > 0 ? body : "(no output yet)"].join("\n"), {
				jobId: job.id,
				status: job.status,
				run: job.run,
				logFile: job.logFile,
			});
		},
	});

	pi.registerTool({
		name: "listen_stop",
		label: "Stop Listener",
		description:
			"Send a signal to a running listener's current process (default SIGTERM) and prevent the loop from restarting. The final exit notification is still delivered.",
		promptSnippet: "Stop a listener and prevent it from restarting",
		parameters: Type.Object({
			id: Type.String({ description: "Listener id (e.g. listen-1)" }),
			signal: Type.Optional(Type.String({ description: "Signal to send, default SIGTERM (e.g. SIGINT, SIGKILL)" })),
		}),
		async execute(_toolCallId, params) {
			const job = jobs.get(params.id);
			if (!job) return textResult(notFound(params.id));
			if (job.status !== "running") return textResult(`${job.id} is not running (${exitText(job)}).`);

			const signal = (params.signal ?? "SIGTERM").toUpperCase();
			if (!/^SIG[A-Z0-9]+$/.test(signal)) return textResult(`Error: invalid signal "${params.signal}". Example: SIGTERM`);

			// Mark first so a run that exits while the signal is in flight cannot
			// restart the loop.
			job.killReason = "user";
			const target = job.child;
			if (!target) {
				return textResult(`${job.id} has no running process to signal.`, { jobId: job.id, signal });
			}
			try {
				target.kill(signal as NodeJS.Signals);
			} catch (error) {
				return textResult(`Error stopping ${job.id}: ${(error as Error).message}`, { jobId: job.id, signal });
			}
			return textResult(`Sent ${signal} to ${job.id}${job.label ? ` "${job.label}"` : ""}. The listener will not restart. Its final notification will still be delivered.`, {
				jobId: job.id,
				signal,
			});
		},
	});

	// -- commands ----------------------------------------------------------

	pi.registerCommand("listen", {
		description: "List listeners started with listen_start",
		handler: async (_args, ctx) => {
			lastCtx = ctx;
			ctx.ui.notify(formatJobList([...jobs.values()]), "info");
			updateWidget();
		},
	});

	pi.registerCommand("listen-stop", {
		description: "Stop a listener: /listen-stop <id> [signal]",
		getArgumentCompletions: (prefix: string) => {
			const items = [...jobs.values()]
				.filter((job) => job.status === "running")
				.map((job) => ({ value: job.id, label: `${job.id}${job.label ? ` — ${job.label}` : ""}` }));
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const [id, rawSignal] = args.trim().split(/\s+/);
			if (!id) {
				ctx.ui.notify("Usage: /listen-stop <id> [signal]", "warning");
				return;
			}
			const job = jobs.get(id);
			if (!job) {
				ctx.ui.notify(notFound(id), "error");
				return;
			}
			if (job.status !== "running") {
				ctx.ui.notify(`${id} is not running (${exitText(job)}).`, "warning");
				return;
			}
			const signal = (rawSignal ?? "SIGTERM").toUpperCase();
			job.killReason = "user";
			try {
				job.child?.kill(signal as NodeJS.Signals);
				ctx.ui.notify(`Sent ${signal} to ${id}. The listener will not restart.`, "info");
			} catch (error) {
				ctx.ui.notify(`Failed to stop ${id}: ${(error as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("listen-clear", {
		description: "Forget finished listeners (running listeners are kept)",
		handler: async (_args, ctx) => {
			lastCtx = ctx;
			let removed = 0;
			for (const [id, job] of jobs) {
				if (job.status !== "running") {
					jobs.delete(id);
					removed += 1;
				}
			}
			ctx.ui.notify(removed > 0 ? `Cleared ${removed} finished listener(s).` : "No finished listeners to clear.", "info");
			updateWidget();
		},
	});
}