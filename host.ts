import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { nativeHostContract } from "./lib/native-host-contract";
import { claudeComplete } from "./lib/claude-completion";

import { codexComplete } from "./lib/codex-completion";
import { opencodeComplete } from "./lib/opencode-completion";

export default experimental_defineHostEntry({
  contract: nativeHostContract,
  handlers: {
    complete: async (input, context) => ({
      text: await ({ claude: claudeComplete, codex: codexComplete, opencode: opencodeComplete }[input.engine])(input, AbortSignal.any([context.signal, context.lifecycle.signal])),
    }),
  },
});
