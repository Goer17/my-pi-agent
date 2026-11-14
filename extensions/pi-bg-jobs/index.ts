/**
 * pi-bg-jobs
 *
 * Run a process in the background and get its output delivered back to the
 * agent as a user message when the process exits (whatever the exit code is).
 *
 * Typical use: start a mail/IM listener, a long build, a watcher, etc. The
 * agent finishes its turn; when the process exits, pi wakes the agent up with
 * the captured stdout/stderr so it can continue the task.
 *
 * The command runs exactly once. For recurring listeners use the separate
 * pi-listen plugin (`listen_start`), which is the looping version of bg_start.
 *
 * Tools:  bg_start, bg_status, bg_output, bg_kill, bg_wait
 * Commands: /jobs, /jobs-kill <id> [signal], /jobs-clear
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_BUFFER_CHARS = 200_000;
const MAX_MESSAGE_LINES = 150;
const MAX_MESSAGE_CHARS = 15_000;
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

interface RunResult {
	output: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	durationMs: number;
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
	const dir = join(tmpdir(), "pi-bg-jobs");
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
	let pending: Array<{ job: Job; result: RunResult }> = [];
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
			return `● ${job.id}${label} · ${formatDuration(Date.now() - job.startedAt)} · ${truncate(job.command, 50)}`;
		});
		const next = lines.length > 0 ? lines : undefined;
		const key = next?.join("\n");
		if (key === widgetKey) return;
		widgetKey = key;
		try {
			lastCtx.ui.setWidget("bg-jobs", next);
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

	function buildRunMessage(job: Job, result: RunResult): string {
		const label = job.label ? ` "${job.label}"` : "";

		let headline: string;
		if (result.jobStatus === "killed") {
			const why = job.killReason === "shutdown" ? "killed on session shutdown" : "killed";
			const sig = result.signal ? `, ${result.signal}` : "";
			headline = `Background job ${job.id}${label} stopped (${why}${sig}).`;
		} else if (result.jobStatus === "failed") {
			headline = `Background job ${job.id}${label} failed to start.`;
		} else {
			headline = `Background job ${job.id}${label} finished with ${runEndText(result)}.`;
		}

		const parts = [`[pi background job notification] ${headline}`, `command: ${job.command}`, `cwd: ${job.cwd}`];
		parts.push(
			`duration: ${formatDuration(result.durationMs)}`,
			`log file: ${job.logFile}`,
			"",
		);

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

		if (result.jobStatus === "killed") {
			parts.push("", "The background job was stopped.");
		} else if (result.jobStatus === "failed") {
			parts.push("", "The background job could not start and has stopped.");
		}

		const stillRunning = [...jobs.values()].filter((other) => other.status === "running" && other.id !== job.id);
		if (stillRunning.length > 0) {
			parts.push("", `still running: ${stillRunning.map((other) => `${other.id}${other.label ? ` "${other.label}"` : ""}`).join(", ")}`);
		}

		parts.push("", "This is an automatic notification, not a user reply. Continue the task using the output above.");
		return parts.join("\n");
	}

	function flushNotifications(force = false) {
		flushTimer = undefined;
		if (pending.length === 0 || !sessionActive) return;
		// While the agent is busy, keep notifications here instead of handing
		// them to pi's follow-up queue: Escape restores that queue into the
		// editor as text. agent_settled (including after an Escape abort) flushes
		// them as a normal user message.
		if (!force && isAgentBusy()) return;

		const batch = pending.splice(0);
		const text = batch.map(({ job, result }) => buildRunMessage(job, result)).join("\n\n");

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
			// call. Keep the batch and retry on the next agent_settled.
			pending.unshift(...batch);
			try {
				lastCtx?.ui.notify(`Failed to deliver background job output: ${(error as Error).message}`, "error");
			} catch {
				// give up
			}
		}
	}

	function queueNotification(job: Job, result: RunResult) {
		if (job.silent || !sessionActive) return;
		pending.push({ job, result });
		if (flushTimer) return;
		flushTimer = setTimeout(() => flushNotifications(), NOTIFY_DEBOUNCE_MS);
		flushTimer.unref?.();
	}

	// -- job lifecycle -----------------------------------------------------

	function endRun(job: Job, code: number | null, signal: NodeJS.Signals | null) {
		if (!job.runActive) return;
		job.runActive = false;
		if (job.timeout) {
			clearTimeout(job.timeout);
			job.timeout = undefined;
		}

		const timedOut = job.timedOutLastRun;
		const stopped = job.killReason === "user" || job.killReason === "shutdown";
		const failed = job.spawnFailed;

		job.exitCode = code;
		job.signal = signal;

		const jobStatus: JobStatus = stopped ? "killed" : failed ? "failed" : "exited";
		const result: RunResult = {
			output: job.output,
			exitCode: code,
			signal,
			timedOut,
			durationMs: Date.now() - job.runStartedAt,
			jobStatus,
		};
		job.lastRun = result;

		job.status = jobStatus;
		job.endedAt = Date.now();
		try {
			job.logStream?.end();
		} catch {
			// ignore
		}
		job.logStream = undefined;

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

		if (!job.silent && sessionActive) {
			try {
				const healthy = jobStatus === "exited" && job.exitCode === 0;
				lastCtx?.ui.notify(`${job.id}${job.label ? ` "${job.label}"` : ""} ${runEndText(result)}`, healthy ? "info" : "warning");
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
			job.logStream?.write(`\n[pi] === started ${new Date().toISOString()} ===\n`);
		} catch {
			// ignore
		}

		const shell = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
		const child = spawn(shell, ["-lc", job.command], {
			cwd: job.cwd,
			env: {
				...process.env,
				PI_BG_JOB_ID: job.id,
				PI_BG_JOB_LABEL: job.label,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		job.child = child;
		job.pid = child.pid;

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
				if (!job.runActive) return;
				job.timedOutLastRun = true;
				pushOutput(job, `\n[pi] timeout of ${timeoutSeconds}s reached, sending SIGTERM\n`);
				try {
					child.kill("SIGTERM");
				} catch {
					// ignore
				}
				setTimeout(() => {
					if (job.runActive) {
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
			endRun(job, null, null);
		});

		let exitTimer: NodeJS.Timeout | undefined;
		child.on("close", (code, signal) => {
			if (exitTimer) clearTimeout(exitTimer);
			onText(stdoutDecoder.end());
			onText(stderrDecoder.end());
			endRun(job, code, signal);
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
				endRun(job, code, signal);
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
		const id = `bg-${seq}`;
		const logFile = join(logDir(), `${id}-${Date.now()}.log`);
		const job: Job = {
			id,
			label: options.label?.trim() ?? "",
			command,
			cwd: options.cwd,
			status: "running",
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
			logStream.write(`[pi] ${new Date().toISOString()} job ${id}${job.label ? ` "${job.label}"` : ""}: ${command}\n`);
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
			const why = job.killReason === "shutdown" ? "killed on session shutdown" : "killed";
			return job.signal ? `${why} (${job.signal})` : why;
		}
		if (job.timedOutLastRun) return job.signal ? `timeout (${job.signal})` : "timeout";
		if (job.exitCode !== undefined && job.exitCode !== null) return `exit code ${job.exitCode}`;
		if (job.signal) return `signal ${job.signal}`;
		return job.status;
	}

	function formatJobList(list: Job[]): string {
		if (list.length === 0) return "No background jobs.";
		const runningCount = list.filter((job) => job.status === "running").length;
		const lines = [`Background jobs (${runningCount} running / ${list.length} total):`];
		for (const job of list) {
			const marker = job.status === "running" ? "●" : "○";
			const label = job.label ? ` "${job.label}"` : "";
			const result =
				job.status === "running"
					? `running for ${formatDuration(Date.now() - job.startedAt)}`
					: `${exitText(job)} after ${formatDuration((job.endedAt ?? Date.now()) - job.startedAt)}`;
			lines.push(`${marker} ${job.id}${label} — ${result} — ${truncate(job.command, 70)}`);
		}
		return lines.join("\n");
	}

	function describeJob(job: Job): string {
		const lines = [
			`${job.id}${job.label ? ` "${job.label}"` : ""} — ${job.status}`,
			`command: ${job.command}`,
			`cwd: ${job.cwd}`,
			`pid: ${job.pid ?? "unknown"}`,
			`started: ${new Date(job.startedAt).toISOString()}`,
		];
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
			? `No background job with id "${id}". There are no background jobs in this session.`
			: `No background job with id "${id}". Known jobs: ${ids.join(", ")}.`;
	}

	// -- events ------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		// Session-scoped state. Jobs from a previous session were killed in
		// session_shutdown; make sure nothing stale survives.
		lastCtx = ctx;
		agentBusy = false;
		sessionActive = true;
		pending = [];
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
		// runs after an Escape abort, so queued background output is sent as a
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
		pending = [];

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
			lastCtx?.ui.setWidget("bg-jobs", undefined);
		} catch {
			// no UI
		}
		widgetKey = undefined;
		jobs.clear();
	});

	// -- tools -------------------------------------------------------------

	pi.registerTool({
		name: "bg_start",
		label: "Start Background Job",
		description:
			"Start a shell command in the background and return immediately. The command runs exactly once. When it exits (with any exit code), its captured stdout/stderr is delivered to you automatically as a user message, so you can keep working instead of blocking. For a recurring listener use the separate pi-listen plugin's listen_start tool.",
		promptSnippet: "Run a shell command once in the background; output is delivered as a user message when it exits",
		promptGuidelines: [
			"Use bg_start instead of bash when a command may block for a long time (long builds or test runs, downloads, servers that eventually exit).",
			"bg_start runs the command exactly once and does not repeat. For recurring listeners (mail/IM waiters, watchers, queues), use listen_start from the pi-listen plugin when it is available.",
			"After bg_start, do not poll or sleep-wait; output arrives automatically as a user message when the process exits. Continue with other work or end your turn.",
			"Use bg_status, bg_output and bg_kill to inspect or stop jobs started with bg_start.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run via bash -lc" }),
			label: Type.Optional(Type.String({ description: "Short human-readable label shown in the UI and notifications" })),
			cwd: Type.Optional(Type.String({ description: "Working directory (defaults to the current cwd)" })),
			timeout: Type.Optional(
				Type.Number({ description: "Optional timeout in seconds; the process is killed when it expires (0 = none)" }),
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
					`Started ${job.id}${job.label ? ` "${job.label}"` : ""} in the background (pid ${job.pid ?? "unknown"}).`,
					`command: ${command}`,
					`cwd: ${cwd}`,
					`log file: ${job.logFile}`,
					"",
					"Do not wait or poll. The output will be sent to you automatically as a user message when the process exits.",
				].join("\n"),
				{ jobId: job.id, pid: job.pid, command, cwd, logFile: job.logFile },
			);
		},
	});

	pi.registerTool({
		name: "bg_status",
		label: "Background Job Status",
		description:
			"List background jobs, or show details for one job. Running jobs show elapsed time; finished jobs show exit status, duration and log path.",
		promptSnippet: "List background jobs or inspect one job's status",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Job id (e.g. bg-1). Omit to list all jobs." })),
		}),
		async execute(_toolCallId, params) {
			if (params.id) {
				const job = jobs.get(params.id);
				if (!job) return textResult(notFound(params.id));
				return textResult(describeJob(job), { jobId: job.id, status: job.status });
			}
			return textResult(formatJobList([...jobs.values()]), { count: jobs.size });
		},
	});

	pi.registerTool({
		name: "bg_output",
		label: "Background Job Output",
		description:
			"Read the captured stdout/stderr of a background job's current (or last) run. Shows the last N lines from the in-memory buffer; the full output of every run is always available in the job's log file.",
		promptSnippet: "Read captured output of a background job",
		parameters: Type.Object({
			id: Type.String({ description: "Job id (e.g. bg-1)" }),
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
				`Output of ${job.id}${job.label ? ` "${job.label}"` : ""} — ${job.status === "running" ? "running" : exitText(job)}`,
				`last ${shown} of ${lines.length} buffered lines${job.truncated ? ` (buffer truncated to last ${MAX_BUFFER_CHARS} chars)` : ""}`,
				`log file: ${job.logFile}`,
			].join("\n");

			return textResult([header, "", body.length > 0 ? body : "(no output yet)"].join("\n"), {
				jobId: job.id,
				status: job.status,
				logFile: job.logFile,
			});
		},
	});

	pi.registerTool({
		name: "bg_kill",
		label: "Kill Background Job",
		description:
			"Send a signal to a running background job (default SIGTERM). The exit notification is still delivered.",
		promptSnippet: "Stop a running background job",
		parameters: Type.Object({
			id: Type.String({ description: "Job id (e.g. bg-1)" }),
			signal: Type.Optional(Type.String({ description: "Signal to send, default SIGTERM (e.g. SIGINT, SIGKILL)" })),
		}),
		async execute(_toolCallId, params) {
			const job = jobs.get(params.id);
			if (!job) return textResult(notFound(params.id));
			if (job.status !== "running") return textResult(`${job.id} is not running (${exitText(job)}).`);

			const signal = (params.signal ?? "SIGTERM").toUpperCase();
			if (!/^SIG[A-Z0-9]+$/.test(signal)) return textResult(`Error: invalid signal "${params.signal}". Example: SIGTERM`);

			job.killReason = "user";
			try {
				job.child?.kill(signal as NodeJS.Signals);
			} catch (error) {
				return textResult(`Error killing ${job.id}: ${(error as Error).message}`);
			}
			return textResult(`Sent ${signal} to ${job.id}${job.label ? ` "${job.label}"` : ""}. Its exit notification will still be delivered.`, {
				jobId: job.id,
				signal,
			});
		},
	});

	pi.registerTool({
		name: "bg_wait",
		label: "Wait For Background Job",
		description:
			"Wait for the current run of a background job to finish, up to a timeout. Usually unnecessary — exit notifications arrive automatically — but useful when you must have the result before the next step.",
		promptSnippet: "Wait (bounded) for a background job's current run to finish",
		parameters: Type.Object({
			id: Type.String({ description: "Job id (e.g. bg-1)" }),
			timeout: Type.Optional(
				Type.Number({ description: `Max seconds to wait (default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS})` }),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const job = jobs.get(params.id);
			if (!job) return textResult(notFound(params.id));

			const seconds = clampInt(params.timeout, 1, MAX_WAIT_SECONDS, DEFAULT_WAIT_SECONDS);
			const result = await waitForJob(job, seconds * 1000, signal);

			const lines: string[] = [];
			if (!result) {
				lines.push(
					`${job.id}${job.label ? ` "${job.label}"` : ""} is still running after ${seconds}s. You will be notified when it exits; no need to keep waiting.`,
				);
			} else {
				lines.push(
					`${job.id}${job.label ? ` "${job.label}"` : ""} finished: ${runEndText(result)} (duration ${formatDuration(result.durationMs)}).`,
				);
			}
			lines.push(`log file: ${job.logFile}`);

			if (result) {
				const t = tailOutput(result.output, 60, 6_000);
				if (t.body.trim().length > 0) {
					lines.push("", "----- output (tail) -----", t.body, "----- end output -----");
				}
			}
			return textResult(lines.join("\n"), {
				jobId: job.id,
				finished: result !== null,
				status: job.status,
			});
		},
	});

	// -- commands ----------------------------------------------------------

	pi.registerCommand("jobs", {
		description: "List one-shot background jobs started with bg_start",
		handler: async (_args, ctx) => {
			lastCtx = ctx;
			ctx.ui.notify(formatJobList([...jobs.values()]), "info");
			updateWidget();
		},
	});

	pi.registerCommand("jobs-kill", {
		description: "Kill a background job: /jobs-kill <id> [signal]",
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
				ctx.ui.notify("Usage: /jobs-kill <id> [signal]", "warning");
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
				ctx.ui.notify(`Sent ${signal} to ${id}.`, "info");
			} catch (error) {
				ctx.ui.notify(`Failed to kill ${id}: ${(error as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("jobs-clear", {
		description: "Forget finished background jobs (running jobs are kept)",
		handler: async (_args, ctx) => {
			lastCtx = ctx;
			let removed = 0;
			for (const [id, job] of jobs) {
				if (job.status !== "running") {
					jobs.delete(id);
					removed += 1;
				}
			}
			ctx.ui.notify(removed > 0 ? `Cleared ${removed} finished job(s).` : "No finished jobs to clear.", "info");
			updateWidget();
		},
	});
}