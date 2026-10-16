import { AgentSandbox } from "./sandbox-do";
export { AgentSandbox };

import type { Env } from "./env";
import { runAgent } from "./agent";
import type { ChatMessage } from "./providers";

function authorized(request: Request, env: Env): boolean {
	if (!env.APP_PASSWORD) return true;
	const header = request.headers.get("Authorization") || "";
	return header === `Bearer ${env.APP_PASSWORD}`;
}

function proxyToSandboxPort(
	request: Request,
	env: Env,
	sessionId: string,
	port: string,
	rest: string,
): Promise<Response> {
	const stub = env.AGENT_SANDBOX.getByName(`sess-${sessionId.toLowerCase()}`);
	const inner = new URL(request.url);
	inner.pathname = `/__port__/${port}${rest || "/"}`;
	const init: RequestInit = {
		method: request.method,
		headers: request.headers,
		redirect: "manual",
	};
	if (request.method !== "GET" && request.method !== "HEAD") {
		init.body = request.body;
		// @ts-expect-error - duplex is required for streaming request bodies
		init.duplex = "half";
	}
	return stub.fetch(new Request(inner.toString(), init));
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/api/health") {
			return Response.json({
				ok: true,
				provider: env.ANTHROPIC_API_KEY ? "anthropic" : "workers-ai",
				auth: Boolean(env.APP_PASSWORD),
			});
		}

		// Public URL for apps the agent runs: /api/session/:id/port/:port/...
		const portMatch = url.pathname.match(
			/^\/api\/session\/([A-Za-z0-9-]+)\/port\/(\d+)(\/.*)?$/,
		);
		if (portMatch) {
			if (!authorized(request, env))
				return new Response("Unauthorized", { status: 401 });
			return proxyToSandboxPort(
				request,
				env,
				portMatch[1],
				portMatch[2],
				portMatch[3] || "/",
			);
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			if (!authorized(request, env))
				return new Response("Unauthorized", { status: 401 });

			let body: { sessionId?: unknown; messages?: unknown };
			try {
				body = (await request.json()) as typeof body;
			} catch {
				return new Response("Invalid JSON", { status: 400 });
			}
			const sessionId =
				typeof body.sessionId === "string" ? body.sessionId.trim() : "";
			const messages = Array.isArray(body.messages)
				? (body.messages as ChatMessage[]).filter(
						(m) =>
							m &&
							(m.role === "user" || m.role === "assistant") &&
							typeof m.content === "string",
					)
				: [];
			if (!sessionId || !/^[A-Za-z0-9-]{1,64}$/.test(sessionId)) {
				return new Response("Bad sessionId", { status: 400 });
			}
			if (!messages.length || messages[messages.length - 1].role !== "user") {
				return new Response("Last message must be from the user", { status: 400 });
			}

			const stream = new ReadableStream({
				async start(controller) {
					const enc = new TextEncoder();
					const send = (event: string, data: Record<string, unknown>) => {
						controller.enqueue(
							enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
						);
					};
					try {
						await runAgent({
							env,
							sessionId,
							baseUrl: url.origin,
							messages,
							send,
						});
					} catch (err) {
						send("error", {
							message: err instanceof Error ? err.message : String(err),
						});
					} finally {
						controller.close();
					}
				},
			});

			return new Response(stream, {
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				},
			});
		}

		// Everything else: the static chat UI.
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
