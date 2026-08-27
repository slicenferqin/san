import { afterEach, describe, expect, it, setSystemTime, spyOn, vi } from "bun:test";
import { Container, TUI } from "@san/tui";
import { Loader, type LoaderMessageColorFn } from "@san/tui/components/loader";
import { visibleWidth } from "@san/tui/utils";
import { VirtualTerminal } from "./virtual-terminal";

describe("Loader component", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("clamps rendered lines to terminal width", async () => {
		const term = new VirtualTerminal(1, 4);
		const tui = new TUI(term);
		const loader = new Loader(
			tui,
			text => text,
			text => text,
			"Checking",
			["⠸"],
		);
		tui.addChild(loader);

		tui.start();
		await Bun.sleep(0);
		await term.flush();

		for (const line of term.getViewport()) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(1);
		}

		loader.stop();
		tui.stop();
	});

	it("requests component renders at the animated message cadence", () => {
		vi.useFakeTimers();
		const ui = { requestComponentRender: vi.fn() };
		const colorMessage = ((text: string) => text) as LoaderMessageColorFn & { animated: true };
		colorMessage.animated = true;
		const loader = new Loader(ui as unknown as TUI, text => text, colorMessage, "Checking", ["0", "1", "2", "3"]);

		vi.advanceTimersByTime(170);

		expect(ui.requestComponentRender).toHaveBeenCalledTimes(3);
		expect(loader.render(20).join("\n")).toContain("2 Checking");
		loader.stop();
	});

	it("supports lightweight TUI stubs through component-scoped renders", () => {
		vi.useFakeTimers();
		const ui = { requestComponentRender: vi.fn() };
		const loader = new Loader(
			ui as unknown as TUI,
			text => text,
			text => text,
			"Checking",
			["0"],
		);

		expect(ui.requestComponentRender).toHaveBeenCalledTimes(1);
		loader.setMessage("Still checking");
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(2);
		expect(loader.render(30).join("\n")).toContain("0 Still checking");

		loader.stop();
	});

	it("skips unchanged frames before the spinner advances", () => {
		vi.useFakeTimers();
		const ui = { requestComponentRender: vi.fn() };
		const colorMessage = ((text: string) => text) as LoaderMessageColorFn;
		const loader = new Loader(ui as unknown as TUI, text => text, colorMessage, "Checking", ["0", "1"]);

		expect(ui.requestComponentRender).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(40);
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(80);
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(2);
		expect(loader.render(20).join("\n")).toContain("1 Checking");

		loader.stop();
	});

	it("requests renders for message changes but not repeated identical messages", () => {
		vi.useFakeTimers();
		const ui = { requestComponentRender: vi.fn() };
		const loader = new Loader(
			ui as unknown as TUI,
			text => text,
			text => text,
			"Checking",
			["0"],
		);

		expect(ui.requestComponentRender).toHaveBeenCalledTimes(1);
		loader.setMessage("Still checking");
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(2);
		expect(loader.render(30).join("\n")).toContain("0 Still checking");
		loader.setMessage("Still checking");
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(2);

		loader.stop();
	});

	it("repaints animated message bytes on each scheduled frame", () => {
		vi.useFakeTimers();
		setSystemTime(new Date(1_000));
		const ui = { synchronizedOutput: false, requestComponentRender: vi.fn() };
		const colorMessage = ((text: string) => `${text}-${Date.now()}`) as LoaderMessageColorFn & { animated: true };
		colorMessage.animated = true;
		const loader = new Loader(ui as unknown as TUI, text => text, colorMessage, "Checking", ["0"]);

		expect(ui.requestComponentRender).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(40);
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(80);
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(2);

		loader.stop();
	});

	it("backs off scheduled paints when component rendering is slow", () => {
		vi.useFakeTimers();
		let now = 0;
		const ui = {
			synchronizedOutput: true,
			requestComponentRender: vi.fn(() => {
				now += 40;
			}),
		};
		const colorMessage = ((text: string) => text) as LoaderMessageColorFn & { animated: true };
		colorMessage.animated = true;
		spyOn(performance, "now").mockImplementation(() => now);
		const loader = new Loader(ui as unknown as TUI, text => text, colorMessage, "Checking", ["0"]);

		expect(ui.requestComponentRender).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(34);
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(200);
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(160);
		expect(ui.requestComponentRender).toHaveBeenCalledTimes(3);

		loader.stop();
	});

	it("reuses text layout when only animated ANSI styling changes", () => {
		vi.useFakeTimers();
		let colorFrame = 0;
		const ui = { synchronizedOutput: true, requestComponentRender: vi.fn() };
		const colorMessage = ((text: string) => `\x1b[3${colorFrame++ % 3}m${text}\x1b[0m`) as LoaderMessageColorFn & {
			animated: true;
		};
		colorMessage.animated = true;
		const loader = new Loader(ui as unknown as TUI, text => text, colorMessage, "Checking", ["⠸"]);
		const stringWidth = spyOn(Bun, "stringWidth");

		const initial = loader.render(40);
		stringWidth.mockClear();
		vi.advanceTimersByTime(34);
		const animated = loader.render(40);

		expect(ui.requestComponentRender).toHaveBeenCalledTimes(2);
		expect(stringWidth).not.toHaveBeenCalled();
		expect(initial[1]).not.toBe(animated[1]);
		expect(visibleWidth(initial[1])).toBe(visibleWidth(animated[1]));
		loader.stop();
	});

	it("dispose() stops the animation so no further renders are scheduled", async () => {
		const term = new VirtualTerminal(20, 4);
		const tui = new TUI(term);
		const loader = new Loader(
			tui,
			text => text,
			text => text,
			"Checking",
			["a", "b", "c"],
		);
		const spy = spyOn(tui, "requestComponentRender");
		loader.dispose();
		const after = spy.mock.calls.length;
		await Bun.sleep(40);
		expect(spy.mock.calls.length).toBe(after);
		expect(() => loader.dispose()).not.toThrow();
		tui.stop();
	});

	it("container disposeChildren stops detached loader repaints", () => {
		vi.useFakeTimers();
		const term = new VirtualTerminal(20, 4);
		const tui = new TUI(term);
		const spy = spyOn(tui, "requestComponentRender");
		const container = new Container();
		const loader = new Loader(
			tui,
			text => text,
			text => text,
			"Checking",
			["0", "1"],
		);
		container.addChild(loader);
		const afterMount = spy.mock.calls.length;

		container.disposeChildren();
		vi.advanceTimersByTime(200);

		expect(spy.mock.calls.length).toBe(afterMount);
		expect(container.children).toEqual([]);
		tui.stop();
	});
});
