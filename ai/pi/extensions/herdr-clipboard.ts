import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Pi copies to the local clipboard and adds OSC 52 only when it sees SSH or mosh.
// A herdr pane has neither, although the viewer may be another machine (herdr
// --remote from Windows). With OSC 52 on, herdr forwards each copy to the
// attached client's clipboard. Pi reads the variable at copy time, so /reload
// is enough for an open session.
export default function (_pi: ExtensionAPI) {
  if (process.env.HERDR_PANE_ID && process.env.PI_CLIPBOARD_OSC52 === undefined) {
    process.env.PI_CLIPBOARD_OSC52 = "1";
  }
}
