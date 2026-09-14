import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServerContext } from "./container";
import { closeDb, getDb } from "./db";
import { RepoManager, type SessionCascade } from "./repos/manager";

/**
 * The composition root's own wiring (issue #150). These are the guarantees
 * that used to be implicit in module-evaluation order and are now explicit:
 * construction happens on demand, and the Repo->Session cascade is closed
 * without the two modules importing each other.
 */

let dataDir: string;
let oldDataDir: string | undefined;

beforeAll(() => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-container-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;
});

afterAll(() => {
	closeDb();
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	rmSync(dataDir, { recursive: true, force: true });
});

describe("createServerContext", () => {
	it("wires both managers against the same data dir", () => {
		const { repos, sessions } = createServerContext();
		expect(repos.reposDir).toBe(path.join(dataDir, "repos"));
		expect(repos.worktreesDir).toBe(path.join(dataDir, "worktrees"));
		expect(sessions).toBeDefined();
	});

	it("builds independent instances per call, so a test can isolate its own", () => {
		const a = createServerContext();
		const b = createServerContext();
		expect(a.repos).not.toBe(b.repos);
		expect(a.sessions).not.toBe(b.sessions);
	});

	it("honours an injected dataDir over the ambient one", () => {
		const { repos } = createServerContext({ dataDir: "/somewhere/else" });
		expect(repos.reposDir).toBe(path.join("/somewhere/else", "repos"));
	});
});

describe("RepoManager.delete cascade", () => {
	/**
	 * The cascade that used to be a hard `import { sessionManager }` — and
	 * therefore a genuine import cycle between the two manager modules. It's
	 * now a structural `SessionCascade` slice, so it can be driven by an
	 * object literal with no SessionManager, no DB and no cloned Repo in
	 * sight. That this test can be written at all is the point of the change.
	 */
	it("deletes every Session on the Repo before removing the Repo itself", async () => {
		const deleted: string[] = [];
		const cascade: SessionCascade = {
			listByRepo: vi.fn(async () => [{ id: "s1" }, { id: "s2" }]),
			delete: vi.fn(async (id: string) => {
				deleted.push(id);
			}),
		};

		// A real `db` (the Repo row has to exist for `delete` to get past its
		// own lookup) but a fake Session side — the seam under test.
		const repos = new RepoManager({ db: getDb(), dataDir });
		repos.setSessions(cascade);
		const repo = await repos.ensureOrchestratorRepo();

		await repos.delete(repo.id);

		expect(cascade.listByRepo).toHaveBeenCalledWith(repo.id);
		expect(deleted).toEqual(["s1", "s2"]);
		// ...and the Repo itself is gone afterwards, not before.
		expect(await repos.get(repo.id)).toBeNull();
	});

	it("refuses to cascade when the Session side was never wired", async () => {
		const repos = new RepoManager({ db: getDb(), dataDir });
		const repo = await repos.ensureOrchestratorRepo();

		// Never got setSessions() — it must fail loudly rather than silently
		// orphan the Repo's Sessions.
		await expect(repos.delete(repo.id)).rejects.toThrow(/setSessions/);
		// And it failed *before* destroying anything.
		expect(await repos.get(repo.id)).not.toBeNull();
	});
});
