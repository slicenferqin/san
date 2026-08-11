import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@san/ai";
import { resetSettingsForTest, Settings } from "@san/coding-agent/config/settings";
import { EventController } from "@san/coding-agent/modes/controllers/event-controller";
import type { InteractiveModeContext } from "@san/coding-agent/modes/types";
import type { AgentSessionEvent } from "@san/coding-agent/session/agent-session";
import { logger } from "@san/utils";

type MessageUpdateEvent = Extract<AgentSessionEvent, { type: "message_update" }>;

function messageUpdate(text: string): MessageUpdateEvent {
	return {
		type: "message_update",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
		},
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
	} as unknown as MessageUpdateEvent;
}

function tailEvent(type: "message_end" | "agent_end"): AgentSessionEvent {
	return { type } as unknown as AgentSessionEvent;
}

function createFixture(): {
	controller: EventController;
	emit: (event: AgentSessionEvent) => void;
} {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const ctx = {
		settings: { get: () => false },
		ui: { requestComponentRender: vi.fn() },
		session: {
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				listeners.push(listener);
				return () => {};
			},
		},
	} as unknown as InteractiveModeContext;
	const controller = new EventController(ctx);
	controller.subscribeToAgent();
	return {
		controller,
		emit: event => {
			for (const listener of listeners) listener(event);
		},
	};
}

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe("EventController message_update 合并", () => {
	const controllers: EventController[] = [];

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		vi.useFakeTimers();
	});

	afterEach(() => {
		for (const controller of controllers.splice(0)) controller.dispose();
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("每个 33ms 窗口只处理最新累计快照", async () => {
		const fixture = createFixture();
		controllers.push(fixture.controller);
		const handled: AgentSessionEvent[] = [];
		vi.spyOn(fixture.controller, "handleEvent").mockImplementation(async event => {
			handled.push(event);
		});

		fixture.emit(messageUpdate("tok1"));
		fixture.emit(messageUpdate("tok1 tok2"));
		fixture.emit(messageUpdate("tok1 tok2 tok3"));
		fixture.emit(messageUpdate("tok1 tok2 tok3 tok4"));

		vi.advanceTimersByTime(32);
		expect(handled).toEqual([]);
		vi.advanceTimersByTime(1);
		await flushMicrotasks();

		expect(handled).toHaveLength(1);
		const latestMessage = (handled[0] as MessageUpdateEvent).message as AssistantMessage;
		expect(latestMessage.content).toEqual([{ type: "text", text: "tok1 tok2 tok3 tok4" }]);
	});

	it("在窗口结束前先 flush 更新，再依次处理 message_end 与 agent_end", async () => {
		const fixture = createFixture();
		controllers.push(fixture.controller);
		const starts: AgentSessionEvent["type"][] = [];
		const latest = messageUpdate("complete snapshot");
		vi.spyOn(fixture.controller, "handleEvent").mockImplementation(async event => {
			starts.push(event.type);
		});

		fixture.emit(messageUpdate("partial"));
		fixture.emit(latest);
		fixture.emit(tailEvent("message_end"));
		fixture.emit(tailEvent("agent_end"));
		await flushMicrotasks();

		expect(starts).toEqual(["message_update", "message_end", "agent_end"]);
	});

	it("定时 flush 尚未完成时，尾事件不会并发越过", async () => {
		const fixture = createFixture();
		controllers.push(fixture.controller);
		const gate = Promise.withResolvers<void>();
		const starts: AgentSessionEvent["type"][] = [];
		let active = 0;
		let maxActive = 0;
		vi.spyOn(fixture.controller, "handleEvent").mockImplementation(async event => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			starts.push(event.type);
			if (event.type === "message_update") await gate.promise;
			active -= 1;
		});

		fixture.emit(messageUpdate("complete snapshot"));
		vi.advanceTimersByTime(33);
		await flushMicrotasks();
		fixture.emit(tailEvent("message_end"));
		fixture.emit(tailEvent("agent_end"));
		await flushMicrotasks();

		expect(starts).toEqual(["message_update"]);
		gate.resolve();
		await flushMicrotasks();

		expect(starts).toEqual(["message_update", "message_end", "agent_end"]);
		expect(maxActive).toBe(1);
	});

	it("观察并记录定时 flush 的 rejection", async () => {
		const fixture = createFixture();
		controllers.push(fixture.controller);
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		vi.spyOn(fixture.controller, "handleEvent").mockRejectedValue(new Error("render rebuild failed"));

		fixture.emit(messageUpdate("snapshot"));
		vi.advanceTimersByTime(33);
		await flushMicrotasks();

		expect(warn).toHaveBeenCalledWith("Message update flush rejected", {
			error: "render rebuild failed",
		});
	});
});
