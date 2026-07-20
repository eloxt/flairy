import * as React from "react";
import type { CustomRenderer, CustomRendererProps } from "streamdown";
import { CARD_LANGUAGES, parseCardBlock } from "@shared/cards";
import {
  CardSkeleton,
  ChartCard,
  CompareCard,
  KvListCard,
  NoteCard,
  ProgressCard,
  StatCard,
  SuggestionsCard,
  TableCard,
  TimelineCard,
} from "./blocks";

/**
 * Streamdown custom renderer mapping ui:* code fences to card components.
 *
 * Contract (zero technical exposure for end users):
 * - fence still streaming and nothing parses yet → skeleton placeholder;
 * - fence closed but parse/validation failed → silently drop the whole block,
 *   never render raw JSON.
 */
function CardFence({ code, language, isIncomplete }: CustomRendererProps) {
  const block = React.useMemo(
    () => parseCardBlock(language, code, { incomplete: isIncomplete }),
    [language, code, isIncomplete],
  );

  if (!block) {
    if (isIncomplete) return <CardSkeleton />;
    return null;
  }

  switch (block.type) {
    case "ui:compare":
      return <CompareCard data={block.data} />;
    case "ui:kv_list":
      return <KvListCard data={block.data} />;
    case "ui:timeline":
      return <TimelineCard data={block.data} />;
    case "ui:note":
      return <NoteCard data={block.data} />;
    case "ui:suggestions":
      return <SuggestionsCard data={block.data} />;
    case "ui:stat":
      return <StatCard data={block.data} />;
    case "ui:table":
      return <TableCard data={block.data} />;
    case "ui:progress":
      return <ProgressCard data={block.data} />;
    case "ui:chart":
      return <ChartCard data={block.data} />;
  }
}

export const cardRenderers: CustomRenderer[] = [
  { language: [...CARD_LANGUAGES], component: CardFence },
];
