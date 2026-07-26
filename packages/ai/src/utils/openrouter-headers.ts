import packageJson from "../../package.json" with { type: "json" };

export function getOpenRouterHeaders(): Record<string, string> {
	return {
		"User-Agent": `San/${packageJson.version}`,
		"HTTP-Referer": "https://github.com/slicenferqin/san",
		"X-OpenRouter-Title": "San",
		"X-OpenRouter-Categories": "cli-agent",
		"X-OpenRouter-Cache": "true",
		"X-OpenRouter-Cache-TTL": "3600",
	};
}
