export const meta = { name: "infinite-loop", description: "Must be stopped by the runtime budget" };
while (true) {
	log("still running");
}
