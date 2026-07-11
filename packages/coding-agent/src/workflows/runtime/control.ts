export type WorkflowRuntimeControlState = "running" | "paused" | "cancelled";

export class WorkflowRuntimeControl {
	#state: WorkflowRuntimeControlState = "running";
	#abortController = new AbortController();
	#resumeGate?: PromiseWithResolvers<void>;

	get state(): WorkflowRuntimeControlState {
		return this.#state;
	}

	get signal(): AbortSignal {
		return this.#abortController.signal;
	}

	pause(): boolean {
		if (this.#state !== "running") return false;
		this.#state = "paused";
		this.#resumeGate = Promise.withResolvers<void>();
		return true;
	}

	resume(): boolean {
		if (this.#state !== "paused") return false;
		this.#state = "running";
		this.#resumeGate?.resolve();
		this.#resumeGate = undefined;
		return true;
	}

	cancel(reason: unknown = new Error("Workflow cancelled by user")): boolean {
		if (this.#state === "cancelled") return false;
		this.#state = "cancelled";
		this.#resumeGate?.resolve();
		this.#resumeGate = undefined;
		this.#abortController.abort(reason);
		return true;
	}

	async checkpoint(signal?: AbortSignal): Promise<void> {
		if (this.#state === "cancelled") throw this.signal.reason ?? new Error("Workflow cancelled by user");
		if (signal?.aborted) throw signal.reason ?? new Error("Workflow execution aborted");
		if (this.#state === "paused") {
			const gate = this.#resumeGate?.promise;
			if (gate && signal) {
				const aborted = Promise.withResolvers<void>();
				const onAbort = () => aborted.reject(signal.reason ?? new Error("Workflow execution aborted"));
				signal.addEventListener("abort", onAbort, { once: true });
				try {
					await Promise.race([gate, aborted.promise]);
				} finally {
					signal.removeEventListener("abort", onAbort);
				}
			} else if (gate) {
				await gate;
			}
		}
		if (this.signal.aborted) throw this.signal.reason ?? new Error("Workflow cancelled by user");
		if (signal?.aborted) throw signal.reason ?? new Error("Workflow execution aborted");
	}
}
