// Pi 1.5 loads extensions with `@earendil-works/pi-ai` aliased to its extension
// view: pi-ai's compat entry plus TypeBox's `Type` and a `StringEnum`. Plain
// `bun test` has no such alias, so mirror it by rewriting that import in this
// package's TypeScript. `mock.module` cannot do it: it resolves the specifier
// to pi-ai's real entry, which has no `Type` export. Pi 1.4 has no view; its
// pi-ai root still exports both.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { plugin } from "bun";

const root = realpathSync(join(import.meta.dir, ".."));
const view = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/pi-ai-extension-view.js");
if (existsSync(view)) {
  const target = JSON.stringify(realpathSync(view));
  const escapedRoot = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  plugin({
    name: "pi-ai-extension-view",
    setup(build) {
      build.onLoad({ filter: new RegExp(`^${escapedRoot}/(?!node_modules/).*\\.ts$`) }, ({ path }) => ({
        contents: readFileSync(path, "utf8").replace(/(from\s*)(["'])@earendil-works\/pi-ai\2/g, `$1${target}`),
        loader: "ts",
      }));
    },
  });
}
