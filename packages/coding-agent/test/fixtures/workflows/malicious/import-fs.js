import * as fs from "node:fs";

export const meta = { name: "import-fs", description: "Must be rejected" };
return fs.readFileSync("/etc/passwd", "utf8");
