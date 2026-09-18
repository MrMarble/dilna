// Seeds the scratch instance `e2e/server.mjs` boots, so the suite can exercise
// the *loaded* state (repo cloned, Session created) rather than only the empty
// instance the shell/clone specs cover (issue #238).
//
// Everything here goes through the server's own HTTP API rather than writing
// rows into the scratch SQLite file. That is the whole point, not an
// implementation detail:
//
//  * A Session is only real if `<dataDir>/worktrees/<slug>/<id>` is a genuine
//    git worktree of `<dataDir>/repos/<slug>`. `GET /:id/changed-files`,
//    `/:id/commits` and the ContextPanel all shell out to git against that
//    path, and boot's `repos.ensureAllGitDefaults()` shells out against the
//    repo path. A hand-written row pointing at a directory that isn't really a
//    worktree produces a fixture that looks seeded and fails at the first
//    assertion.
//  * The clone/session code paths are themselves part of what's under test, so
//    seeding by driving them means the specs start from state the app can
//    actually reach.
//
// Git gets its remote from a **local bare repository created inside the
// scratch data dir**, never a network remote — the offline/no-flake constraint
// #224 called out stays intact. `git clone` accepts any local path as a URL, so
// the bare repo is a perfectly ordinary remote as far as the server is
// concerned; it just can't be reached from another machine. Putting it under
// `DILNA_DATA_DIR` is also what makes teardown free: `server.mjs` already
// removes that directory on exit, so there is nothing extra to clean up.
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const git = (args, cwd) => execFileAsync("git", args, { cwd });

/** Slug the seed repo is cloned under, i.e. the `/<slug>/<id>` URL segment the
 * specs navigate to. Exported so a spec never re-types the literal. */
export const SEED_REPO_SLUG = "seeded-repo";

/** Committed to the seed repo's `main`, so a Session created from it has a
 * commit for the ContextPanel's "Recent commits" section to list. */
export const SEED_COMMIT_SUBJECT = "Add greeting helper";

/** Written into the Session's Worktree *after* it is created, so the panel's
 * "Changed files" section has an uncommitted change to show — the state a user
 * is actually in mid-Session. */
export const SEED_CHANGED_FILE = "src/greeting.ts";
/** Plain string, not a template literal — the content happens to look like TS,
 * and an escaped `` ${...} `` in a non-template string is both wrong-looking
 * and a lint error (`noTemplateCurlyInString`). */
export const SEED_CHANGED_FILE_CONTENT =
	'export function greeting(name: string) {\n\treturn "hello " + name;\n}\n';

/**
 * Create the seed repo's git history and publish it as a bare remote, then
 * return the remote's path. Returns a *bare* repo because that is what
 * `RepoManager.clone` runs `git clone --bare` against in production; a
 * non-bare source works too, but the bare one is the shape the real flow sees.
 */
async function createBareRemote(baseDir) {
	const sourceDir = path.join(baseDir, "seed-source");
	const remoteDir = path.join(baseDir, `${SEED_REPO_SLUG}.git`);

	await mkdir(sourceDir, { recursive: true });
	await git(["init", "-b", "main"], sourceDir);
	// Committing needs an identity; the container may have no global one, and
	// `git commit` failing on "please tell me who you are" would look like a
	// fixture bug rather than a missing config.
	await git(["config", "user.email", "e2e@dilna.local"], sourceDir);
	await git(["config", "user.name", "dilna e2e"], sourceDir);

	await writeFile(
		path.join(sourceDir, "README.md"),
		"# Seeded repo\n\nFixture for the loaded-state e2e specs.\n",
	);
	await mkdir(path.join(sourceDir, "src"), { recursive: true });
	await writeFile(
		path.join(sourceDir, "src", "index.ts"),
		"export const answer = 42;\n",
	);
	await git(["add", "-A"], sourceDir);
	await git(["commit", "-m", "Initial commit"], sourceDir);

	// A second commit so the panel's commit list has more than one row, and so
	// the history isn't a single-commit degenerate case.
	await writeFile(
		path.join(sourceDir, "src", "math.ts"),
		"export const add = (a: number, b: number) => a + b;\n",
	);
	await git(["add", "-A"], sourceDir);
	await git(["commit", "-m", SEED_COMMIT_SUBJECT], sourceDir);

	await git(["clone", "--bare", sourceDir, remoteDir], baseDir);
	return remoteDir;
}

async function post(baseUrl, route, body) {
	const res = await fetch(`${baseUrl}${route}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const text = await res.text();
	if (!res.ok) {
		throw new Error(`seed: POST ${route} → ${res.status} ${text}`);
	}
	return JSON.parse(text);
}

/**
 * Seed `baseUrl` (an already-listening dilna server) and return the ids the
 * specs need to address the seeded Session.
 *
 * `baseUrl` must already be up: `server.mjs` calls this after its own health
 * poll, and *before* letting Playwright's `webServer.url` probe succeed — so a
 * spec can never observe a half-seeded instance.
 */
export async function seedInstance({ baseUrl, baseDir }) {
	const remoteDir = await createBareRemote(baseDir);

	const { repo } = await post(baseUrl, "/api/repos", {
		url: remoteDir,
		slug: SEED_REPO_SLUG,
	});

	const { session } = await post(baseUrl, "/api/sessions", {
		repoId: repo.id,
	});

	// The worktree exists by the time `POST /api/sessions` returns (its insert
	// rolls the worktree back on failure), so writing into it here is the
	// "user has local changes" state rather than a race.
	//
	// The layout is `SessionManager`'s (`worktrees/<slug>/<id>`); `worktreePath`
	// is not on `SessionView` — it's server-internal — so it can't be read back
	// off the response. If that layout ever moves, this write fails loudly with
	// ENOENT rather than silently seeding nothing.
	await writeFile(
		path.join(
			baseDir,
			"worktrees",
			SEED_REPO_SLUG,
			session.id,
			SEED_CHANGED_FILE,
		),
		SEED_CHANGED_FILE_CONTENT,
	);

	return { repo, session, remoteDir };
}
