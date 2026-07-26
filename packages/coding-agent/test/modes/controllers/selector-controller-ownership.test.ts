import { describe, expect, it, vi } from "bun:test";
import { SelectorController } from "@san/coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@san/coding-agent/modes/types";
import { Container, Text } from "@san/tui";

describe("SelectorController editor-area ownership", () => {
	it("does not let a stale selector completion replace a newer surface", () => {
		const editorContainer = new Container();
		const editor = new Text("editor", 0, 0);
		editorContainer.addChild(editor);
		const setFocus = vi.fn();
		const requestRender = vi.fn();
		const controller = new SelectorController({
			editorContainer,
			editor,
			ui: { setFocus, requestRender },
		} as unknown as InteractiveModeContext);
		let finish: (() => void) | undefined;
		const selector = new Container();
		selector.addChild(new Text("selector", 0, 0));
		const dispose = vi.spyOn(selector, "dispose");

		controller.showSelector(done => {
			finish = done;
			return { component: selector, focus: selector };
		});
		const newerSurface = new Text("newer", 0, 0);
		editorContainer.clear();
		editorContainer.addChild(newerSurface);
		finish?.();

		expect(editorContainer.children).toEqual([newerSurface]);
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(setFocus).not.toHaveBeenLastCalledWith(editor);
	});

	it("disposes a selector displaced by a newer selector", () => {
		const editorContainer = new Container();
		const editor = new Text("editor", 0, 0);
		editorContainer.addChild(editor);
		const controller = new SelectorController({
			editorContainer,
			editor,
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
		} as unknown as InteractiveModeContext);
		const first = new Container();
		const dispose = vi.spyOn(first, "dispose");
		controller.showSelector(() => ({ component: first, focus: first }));
		const second = new Container();

		controller.showSelector(() => ({ component: second, focus: second }));

		expect(dispose).toHaveBeenCalledTimes(1);
		expect(editorContainer.children).toEqual([second]);
	});

	it("does not bounce scoped-out models into provider connection", () => {
		const showWarning = vi.fn();
		const controller = new SelectorController({
			session: {
				getAvailableModels: () => [],
				modelRegistry: { getAvailable: () => [{}] },
			},
			showWarning,
		} as unknown as InteractiveModeContext);

		controller.showModelSelector();

		expect(showWarning).toHaveBeenCalledWith("No models match the current --models or enabled-model scope.");
	});
});
