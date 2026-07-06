import { getDb } from "./index";

async function main() {
	const db = getDb();
	console.log("Migrations applied.");
	db.run("VACUUM");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
