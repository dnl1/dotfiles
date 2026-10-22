import assert from "node:assert/strict";
import test from "node:test";
import herdrClipboard from "../ai/pi/extensions/herdr-clipboard.ts";

function withEnv(t, values) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) value === undefined ? delete process.env[key] : process.env[key] = value;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
  });
}

test("inside a herdr pane, pi also copies through OSC 52", (t) => {
  withEnv(t, { HERDR_PANE_ID: "pane-1", PI_CLIPBOARD_OSC52: undefined });
  herdrClipboard({});
  assert.equal(process.env.PI_CLIPBOARD_OSC52, "1");
});

test("outside herdr nothing changes", (t) => {
  withEnv(t, { HERDR_PANE_ID: undefined, PI_CLIPBOARD_OSC52: undefined });
  herdrClipboard({});
  assert.equal(process.env.PI_CLIPBOARD_OSC52, undefined);
});

test("an explicit choice is kept", (t) => {
  withEnv(t, { HERDR_PANE_ID: "pane-1", PI_CLIPBOARD_OSC52: "0" });
  herdrClipboard({});
  assert.equal(process.env.PI_CLIPBOARD_OSC52, "0");
});
