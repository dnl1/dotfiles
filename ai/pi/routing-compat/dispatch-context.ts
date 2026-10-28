import { AsyncLocalStorage } from "node:async_hooks";
import type { Api, Model } from "@earendil-works/pi-ai";

const dispatch = new AsyncLocalStorage<{ sessionId: string; model: Model<Api> }>();

export function withDispatchModel<T>(sessionId: string | undefined, model: Model<Api>, action: () => T): T {
	return sessionId ? dispatch.run({ sessionId, model }, action) : action();
}

export function getDispatchModel(sessionId: string): Model<Api> | undefined {
	const current = dispatch.getStore();
	return current?.sessionId === sessionId ? current.model : undefined;
}
