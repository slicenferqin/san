const EXPLICIT_USER_MEMORY_DIRECTIVE_PATTERN =
	/(?:^|[\n.!?。！？]\s*)(?<directive>(?:(?:(?:please\s+)?remember(?:\s+(?:that|to))?|(?:please\s+)?keep(?:\s+(?:this|that|the following))?\s+in mind|from now on|going forward|my preference\s*(?:is|:))(?:\s*[,\-:]\s*|\s+)|(?:请记住|记住(?:这个|以下|我的)|以后(?:请|都|要)|今后|从现在开始|我的偏好(?:是|：|:))[\s,，\-:：]*)\S[^\n.!?。！？]*[.。]?)/iu;
const NEGATED_MEMORY_DIRECTIVE_PATTERN =
	/\b(?:do\s+not|don't|dont|never)\s+remember\b|(?:不要|别|无需|不用|不必)(?:再)?记住/iu;

export function extractExplicitUserMemoryDirective(value: string): string | undefined {
	const input = value.trim();
	const match = EXPLICIT_USER_MEMORY_DIRECTIVE_PATTERN.exec(input);
	if (!match) return undefined;
	const directive = match.groups?.directive?.trim();
	if (!directive || NEGATED_MEMORY_DIRECTIVE_PATTERN.test(directive)) return undefined;
	const trailingText = input.slice(match.index + match[0].length).trimStart();
	if (trailingText.startsWith("?") || trailingText.startsWith("？")) return undefined;
	return directive;
}
