export const meta = {
	name: "claude-public",
	description: "Audit route handlers",
};

const found = await agent("List every route handler.", {
	schema: {
		type: "object",
		required: ["files"],
		properties: { files: { type: "array", items: { type: "string" } } },
	},
});

const audits = await pipeline(found.files, file => agent(`Audit ${file}.`, { label: file }));
return audits.filter(Boolean);
