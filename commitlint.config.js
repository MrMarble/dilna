export default {
	extends: ["@commitlint/config-conventional"],
	rules: {
		// release-please-config.json maps "deps" to its own changelog section
		// (grouped with "chore") — extend the default type-enum to accept it.
		"type-enum": [
			2,
			"always",
			[
				"build",
				"chore",
				"ci",
				"deps",
				"docs",
				"feat",
				"fix",
				"perf",
				"refactor",
				"revert",
				"style",
				"test",
			],
		],
	},
};
