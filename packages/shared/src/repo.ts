export type Repo = {
	id: string;
	slug: string;
	path: string;
	defaultBranch: string;
	remoteUrl: string;
	createdAt: number;
};

export type CloneRepoInput = {
	url: string;
	slug?: string;
};
