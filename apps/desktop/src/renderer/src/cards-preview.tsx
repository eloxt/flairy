import { createRoot } from "react-dom/client";

// Development-only gallery. It does not connect to Electron or send prompts.
if (!import.meta.env.DEV) throw new Error("Cards preview is development-only");
window.api = {
  getInitialLanguage: () => "zh-CN",
  onLanguageChanged: () => () => {},
} as unknown as typeof window.api;
const root =
  import.meta.hot?.data.root ?? createRoot(document.getElementById("root")!);
if (import.meta.hot) import.meta.hot.data.root = root;
void import("./components/chat/cards/preview-page").then(
  ({ default: PreviewPage }) => {
    root.render(<PreviewPage />);
  },
);
