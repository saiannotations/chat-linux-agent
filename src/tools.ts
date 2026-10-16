import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "./env";
import type { AgentSandbox, ShellResult } from "./sandbox-do";
import type { ToolDef } from "./providers";

export interface ToolContext {
	env: Env;
	sandbox: DurableObjectStub<AgentSandbox>;
	/** Public base URL of this worker, for building share links. */
	baseUrl: string;
	/** Chat session id, for building share links. */
	sessionId: string;
}

export interface ToolOutput {
	/** Plain-text result fed back to the model (and shown in chat). */
	output: string;
	/** Optional screenshot to show in the browser-view panel. */
	shot?: { url: string; image: string };
}

const MAX_OUT = 8000;

function clip(text: string): string {
	if (text.length <= MAX_OUT) return text;
	return (
		text.slice(0, MAX_OUT) +
		`\n…[truncated, ${text.length - MAX_OUT} more chars]`
	);
}

function fmtShell(res: ShellResult): string {
	let out = `$ exit code: ${res.exitCode}`;
	if (res.timedOut) out += " (TIMED OUT — process killed)";
	if (res.stdout.trim()) out += `\n--- stdout ---\n${clip(res.stdout)}`;
	if (res.stderr.trim()) out += `\n--- stderr ---\n${clip(res.stderr)}`;
	if (!res.stdout.trim() && !res.stderr.trim()) out += "\n(no output)";
	return out;
}

export const TOOL_DEFS: ToolDef[] = [
	{
		name: "shell",
		description:
			"Run a shell command on the Linux sandbox (Debian, working dir /workspace, internet on). Use for anything: installing packages, running scripts, git, curl, python, node, etc. Long commands should finish within the timeout.",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "Shell command to run" },
				timeout_seconds: {
					type: "number",
					description: "Kill the command after this many seconds (default 60, max 120)",
				},
			},
			required: ["command"],
		},
	},
	{
		name: "run_background",
		description:
			"Start a long-running command in the background (e.g. a web server like `python3 -m http.server 8000`). It keeps running after the tool returns. Logs go to /tmp/chat-agent-bg.log. Pair with expose_port to share it with the user.",
		parameters: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description: "Command to run detached, e.g. `python3 -m http.server 8000`",
				},
			},
			required: ["command"],
		},
	},
	{
		name: "expose_port",
		description:
			"Get a public HTTPS URL for a TCP port the sandbox is listening on, so the user can open the app in their own browser. The URL is proxied through this worker and stays up while the sandbox is awake.",
		parameters: {
			type: "object",
			properties: {
				port: { type: "number", description: "Port the sandbox is listening on" },
			},
			required: ["port"],
		},
	},
	{
		name: "read_file",
		description: "Read a text file from the sandbox filesystem.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Absolute path, e.g. /workspace/app.py" },
			},
			required: ["path"],
		},
	},
	{
		name: "write_file",
		description:
			"Create or overwrite a text file in the sandbox. Parent dirs are created as needed.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Absolute path, e.g. /workspace/app.py" },
				content: { type: "string", description: "Full file content" },
			},
			required: ["path", "content"],
		},
	},
	{
		name: "list_dir",
		description: "List files in a sandbox directory.",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Absolute path (default /workspace)",
				},
			},
			required: [],
		},
	},
	{
		name: "browser_screenshot",
		description:
			"Open a URL in the cloud browser and take a screenshot. The screenshot is shown to the user in the Browser view panel. Use it to see a page exactly as it renders, check on work, or read visual content.",
		parameters: {
			type: "object",
			properties: {
				url: { type: "string", description: "https:// URL to open" },
				width: { type: "number", description: "Viewport width (default 1280)" },
				height: { type: "number", description: "Viewport height (default 800)" },
			},
			required: ["url"],
		},
	},
	{
		name: "browser_read",
		description:
			"Open a URL in the cloud browser and return its title plus rendered text content. Use for reading articles, docs, or pages where a screenshot is not needed.",
		parameters: {
			type: "object",
			properties: {
				url: { type: "string", description: "https:// URL to open" },
				max_chars: {
					type: "number",
					description: "Max characters of text to return (default 6000)",
				},
			},
			required: ["url"],
		},
	},
];

async function launchPage(ctx: ToolContext, url: string) {
	if (!/^https?:\/\//i.test(url)) throw new Error("URL must start with http:// or https://");
	const browser = await puppeteer.launch(ctx.env.BROWSER);
	const page = await browser.newPage();
	await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });
	return { browser, page };
}

export async function executeTool(
	name: string,
	args: Record<string, unknown>,
	ctx: ToolContext,
): Promise<ToolOutput> {
	const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
	const num = (v: unknown, d: number) =>
		typeof v === "number" && Number.isFinite(v) ? v : d;

	switch (name) {
		case "shell": {
			const timeoutMs = Math.min(Math.max(num(args.timeout_seconds, 60), 1), 120) * 1000;
			const res = await ctx.sandbox.execShell(str(args.command), timeoutMs);
			return { output: fmtShell(res) };
		}

		case "run_background": {
			const cmd = str(args.command);
			if (!cmd) throw new Error("command is required");
			const log = "/tmp/chat-agent-bg.log";
			// setsid + nohup so it survives after exec returns.
			const res = await ctx.sandbox.execShell(
				`setsid nohup sh -c ${JSON.stringify(cmd)} >>${log} 2>&1 < /dev/null & echo "started pid $!"`,
				15000,
			);
			return {
				output: `Background process launched.\n${fmtShell(res)}\nLogs: ${log} (use shell: tail -n 50 ${log})`,
			};
		}

		case "expose_port": {
			const port = Math.floor(num(args.port, 0));
			if (!port || port < 1 || port > 65535) throw new Error("port must be 1-65535");
			const check = await ctx.sandbox.execShell(
				`(curl -s -o /dev/null -m 3 http://127.0.0.1:${port}/ && echo LISTENING) || echo NOT_LISTENING`,
				15000,
			);
			const shareUrl = `${ctx.baseUrl}/api/session/${ctx.sessionId}/port/${port}/`;
			return {
				output:
					`Port check: ${check.stdout.trim() || "unknown"}\n` +
					`Public URL: ${shareUrl}\n` +
					(check.stdout.includes("LISTENING")
						? "The user can open this URL now."
						: "Nothing is listening yet — start the server with run_background first, then share this URL."),
			};
		}

		case "read_file": {
			const content = await ctx.sandbox.readFile(str(args.path));
			return { output: clip(content) || "(empty file)" };
		}

		case "write_file": {
			const path = str(args.path);
			if (!path.startsWith("/")) throw new Error("path must be absolute");
			await ctx.sandbox.execShell(
				`mkdir -p ${JSON.stringify(path.split("/").slice(0, -1).join("/") || "/")}`,
				15000,
			);
			await ctx.sandbox.writeFile(path, str(args.content));
			return { output: `Wrote ${str(args.content).length} chars to ${path}` };
		}

		case "list_dir": {
			const entries = await ctx.sandbox.listDir(str(args.path, "/workspace"));
			if (!entries.length) return { output: "(empty directory)" };
			return {
				output: entries.map((e) => `${e.type === "directory" ? "📁" : "📄"} ${e.name}`).join("\n"),
			};
		}

		case "browser_screenshot": {
			const url = str(args.url);
			const width = Math.min(Math.max(Math.floor(num(args.width, 1280)), 320), 1920);
			const height = Math.min(Math.max(Math.floor(num(args.height, 800)), 240), 1200);
			const { browser, page } = await launchPage(ctx, url);
			try {
				await page.setViewport({ width, height });
				const shot = (await page.screenshot({
					type: "jpeg",
					quality: 70,
				})) as unknown as ArrayBuffer;
				const b64 = Buffer.from(shot).toString("base64");
				return {
					output: `Screenshot captured: ${url} (${width}x${height}). It is now visible to the user in the Browser view panel.`,
					shot: { url, image: `data:image/jpeg;base64,${b64}` },
				};
			} finally {
				await browser.close();
			}
		}

		case "browser_read": {
			const url = str(args.url);
			const maxChars = Math.min(Math.max(Math.floor(num(args.max_chars, 6000)), 500), 20000);
			const { browser, page } = await launchPage(ctx, url);
			try {
				const title = await page.title();
				const text = await page.evaluate(
					`() => (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n")`,
				);
				return {
					output: `Title: ${title}\nURL: ${url}\n--- page text ---\n${clip(String(text)).slice(0, maxChars)}`,
				};
			} finally {
				await browser.close();
			}
		}

		default:
			throw new Error(`Unknown tool: ${name}`);
	}
}
