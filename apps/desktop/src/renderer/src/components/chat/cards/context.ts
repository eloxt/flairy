import { createContext } from "react";

/** Message-local state: old cards must not inherit another turn's activity. */
export const CardContext = createContext({
  streaming: false,
  preview: false,
  sessionId: null as string | null,
});
