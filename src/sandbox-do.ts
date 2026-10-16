import { DurableObject } from "cloudflare:workers";
import { Files } from "@cloudflare/sandbox";
import type { Env } from "./env";

const INACTIVITY_TIMEOUT_MS = 20 * 60 * 1000;

export interface ShellResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	timedOut: boolean;
}

/**
 * One chat session's Linux computer. A Durable Object that owns a Container,
 * so the sandbox survives across requests and idles out after inactivity.
 */
export class AgentSandbox extends DurableObject<Env> {
	private readonly container: Container;
	private readonly files: Files;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const container = ctx.container;
		if (!container) throw new Error("The container binding is not configured");
		this.container = container;
		this.files = new Files(container);

		// A restarted Durable Object re-arms the idle timeout.
		if (container.running) {
			void ctx.blockConcurrencyWhile(() =>
				container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS),
			);
		}
	}

	private async ensureStarted(): Promise<void> {
		if (this.container.running) return;
		this.container.start({
			image: this.container.images.agent,
			enableInternet: true,
		});
		await this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
		// Wait until the container actually accepts exec.
		for (let i = 0; i < 30; i++) {
			try {
				const proc = await this.container.exec(["sh", "-c", "true"]);
				const out = await proc.output();
				if (out.exitCode === 0) return;
			} catch {
				/* still booting */
			}
			await new Promise((r) => setTimeout(r, 1000));
		}
		throw new Error("Sandbox container failed to boot in time");
	}

	/** Run a shell command in /workspace. Kills it if it exceeds timeoutMs. */
	async execShell(cmd: string, timeoutMs: number): Promise<ShellResult> {
		await this.ensureStarted();
		const proc = await this.container.exec(["sh", "-c", cmd], {
			cwd: "/workspace",
		});
		const timeout = new Promise<null>((resolve) =>
			setTimeout(() => resolve(null), timeoutMs),
		);
		const done = await Promise.race([proc.output(), timeout]);
		if (done === null) {
			try {
				proc.kill();
			} catch {
				/* already gone */
			}
			return { stdout: "", stderr: "", exitCode: -1, timedOut: true };
		}
		const dec = new TextDecoder();
		return {
			stdout: dec.decode(done.stdout),
			stderr: dec.decode(done.stderr),
			exitCode: done.exitCode,
			timedOut: false,
		};
	}

	async readFile(path: string): Promise<string> {
		await this.ensureStarted();
		const res = await this.files.readFile(path);
		return await res.text();
	}

	async writeFile(path: string, content: string): Promise<void> {
		await this.ensureStarted();
		await this.files.writeFile(path, content);
	}

	async listDir(path: string): Promise<{ name: string; type: string }[]> {
		await this.ensureStarted();
		return await this.files.readDirectory(path);
	}

	/**
	 * Proxies HTTP into a port inside the container, e.g. GET /__port__/8000/
	 * Used by the worker route /api/session/:id/port/:port/* so the user can
	 * open apps the agent starts in their own browser tab.
	 */
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const m = url.pathname.match(/^\/__port__\/(\d+)(\/.*)?$/);
		if (!m) return new Response("Not found", { status: 404 });
		if (!this.container.running) {
			return new Response(
				"Sandbox is not running. Ask the agent in chat to start the server again.",
				{ status: 503 },
			);
		}
		const port = Number(m[1]);
		const target = new URL(request.url);
		target.pathname = m[2] || "/";
		const fetcher = this.container.getTcpPort(port);
		const init: RequestInit = {
			method: request.method,
			headers: request.headers,
			redirect: "manual",
		};
		if (request.method !== "GET" && request.method !== "HEAD") {
			init.body = request.body;
			// @ts-expect-error - duplex is required for streaming bodies in workers
			init.duplex = "half";
		}
		return fetcher.fetch(new Request(target.toString(), init));
	}
}
