/**
 * The web's fixture factories now live in `@dilna/shared/testing`, so the
 * server's suites can use the same ones (the two copies had already drifted on
 * `makeSession`'s `title`). Re-exported here so existing `@/test/factories`
 * imports keep working; new code can import from either.
 */
export {
	makeArtefact,
	makeAttachment,
	makeRepo,
	makeSession,
} from "@dilna/shared/testing";
