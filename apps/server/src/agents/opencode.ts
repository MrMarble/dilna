import { spawn } from "node:child_process";
import net from "node:net";
import { setTimeout as setTimeoutAsync } from "node:timers/promises";
import { createOpencodeClient } from "@opencode-ai/sdk";
import type {
	Agent,
	AgentChatOptions,
	AgentHandle,
	AgentStartOptions,
} from "./types";

export class OpencodeAgent implements Agent {
	async start(opts: AgentStartOptions): Promise<AgentHandle> {
		const port = await pickFreePort();
		const child = spawn(
			"opencode",
			[
				"serve",
				"--port",
				String(port),
				"--hostname",
				"127.0.0.1",
				"--auto",
				opts.worktreePath,
			],
			{
				stdio: ["ignore", "pipe", "pipe"],
				cwd: opts.worktreePath,
				env: process.env,
			},
		);
		const stderrTail: string[] = [];
		child.stderr?.on("data", (b: Buffer) => {
			const line = b.toString().trim();
			if (line) stderrTail.push(line);
			if (stderrTail.length > 50) stderrTail.shift();
		});
		const url = await waitForReady(child, 10_000);
		const client = createOpencodeClient({ baseUrl: url, throwOnError: true });
		let agentSessionId = opts.existingAgentSessionId;
		if (!agentSessionId) {
			const result = await client.session.create({ throwOnError: true });
			agentSessionId = result.data.id;
		}
		const sessionId = agentSessionId;
		let killed = false;
		const kill = () =>
			new Promise<void>((resolve) => {
				if (killed) return resolve();
				killed = true;
				child.once("exit", () => resolve());
				child.kill("SIGTERM");
				setTimeoutAsync(3_000).then(() => {
					if (!child.killed) child.kill("SIGKILL");
				});
			});
		return {
			agentSessionId: sessionId,
			stop: kill,
			isIdle: () => !child.killed,
		};
	}

	async chat(_handle: AgentHandle, _opts: AgentChatOptions): Promise<void> {
		throw new Error("TODO: implement opencode chat streaming");
	}

	async stop(handle: AgentHandle): Promise<void> {
		await handle.stop();
	}

	isIdle(handle: AgentHandle): boolean {
		return handle.isIdle();
	}
}

function pickFreePort(): Promise<number> {
	return new Promise((res, rej) => {
		const s = net.createServer();
		s.unref();
		s.once("error", rej);
		s.listen(0, "127.0.0.1", () => {
			const addr = s.address();
			if (addr && typeof addr === "object") res(addr.port);
			else rej(new Error("no port"));
			s.close();
		});
	});
}

async function waitForReady(
	child: ReturnType<typeof spawn>,
	timeoutMs: number,
): Promise<string> {
	return await new Promise<string>((resolve, reject) => {
		let output = "";
		const start = Date.now();
		const onTimeout = () => {
			cleanup();
			reject(
				new Error(`opencode serve did not become ready within ${timeoutMs}ms`),
			);
		};
		const timer = setTimeout(onTimeout, timeoutMs - (Date.now() - start));
		const cleanup = () => {
			clearTimeout(timer);
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			for (const line of output.split("\n")) {
				if (line.includes("opencode server listening")) {
					const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
					if (match?.[1]) {
						cleanup();
						resolve(match[1]);
						return;
					}
				}
			}
		});
		child.on("exit", (code: number | null) => {
			cleanup();
			reject(new Error(`opencode serve exited with code ${code}`));
		});
	});
}
