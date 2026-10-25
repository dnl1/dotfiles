import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import codex from "./vendor/pi-codex-native/src/extension.ts";
import autoModel from "./vendor/pi-auto-model/extensions/auto-model.ts";

export default function routingCompat(pi: ExtensionAPI): void {
	autoModel(pi);
	codex(pi);
}
