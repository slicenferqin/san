/**
 * 结束未引用 `cd` 目标 token 的 shell 元字符。目标后出现重定向、
 * 额外参数或其他操作符时，必须把完整命令交还 shell 解释。
 */
const CD_TARGET_TERMINATORS: Record<string, true> = {
	" ": true,
	"\t": true,
	"\n": true,
	"\r": true,
	"&": true,
	"|": true,
	";": true,
	"<": true,
	">": true,
	"(": true,
	")": true,
};

/**
 * 解析开头的裸 `cd <path> && ...`，仅提取一个路径 token。
 *
 * 遇到重定向、额外参数、shell 展开、行继续符或非 `&&` 分隔符时返回
 * `null`，避免把 shell 语法误当成结构化 cwd。
 */
export function extractLeadingCdTarget(command: string): { path: string; rest: string } | null {
	const prefix = /^cd[ \t]+/.exec(command);
	if (!prefix) return null;

	let index = prefix[0].length;
	let target = "";
	let inSingleQuote = false;
	let inDoubleQuote = false;

	for (; index < command.length; index++) {
		const char = command[index];
		if (inSingleQuote) {
			if (char === "'") {
				inSingleQuote = false;
				continue;
			}
			target += char;
			continue;
		}
		if (inDoubleQuote) {
			if (char === "\\" && index + 1 < command.length) {
				const next = command[index + 1];
				if (next === "\n" || next === "\r") return null;
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					target += next;
					index++;
					continue;
				}
			}
			if (char === '"') {
				inDoubleQuote = false;
				continue;
			}
			target += char;
			continue;
		}
		if (char === "'") {
			inSingleQuote = true;
			continue;
		}
		if (char === '"') {
			inDoubleQuote = true;
			continue;
		}
		if (char === "\\" && index + 1 < command.length) {
			if (command[index + 1] === "\n" || command[index + 1] === "\r") return null;
			target += command[index + 1];
			index++;
			continue;
		}
		if (CD_TARGET_TERMINATORS[char]) break;
		target += char;
	}

	if (inSingleQuote || inDoubleQuote || target.length === 0) return null;
	if (/[$`(]/.test(target)) return null;
	while (command[index] === " " || command[index] === "\t") index++;
	if (command[index] !== "&" || command[index + 1] !== "&") return null;
	index += 2;
	while (command[index] === " " || command[index] === "\t") index++;
	return { path: target, rest: command.slice(index) };
}
