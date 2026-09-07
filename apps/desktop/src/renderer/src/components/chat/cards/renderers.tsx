import * as React from "react";
import { useTranslation } from "react-i18next";
import { CardContext } from "./context";
import { CardSources } from "../Citations";
import type { CardBlock } from "@shared/cards";
import type { CustomRenderer, CustomRendererProps } from "streamdown";
import { CARD_LANGUAGES, parseCardBlock } from "@shared/cards";
import {
  ArtifactCard,
  CardShell,
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

/** Shared by Streamdown and the internal fixture gallery. */
export function CardFence({
  code,
  language,
  isIncomplete,
}: CustomRendererProps) {
  const { t } = useTranslation();
  const environment = React.useContext(CardContext);
  const incomplete = isIncomplete && environment.streaming;
  const { block, issues } = React.useMemo(() => {
    const issues: { path: string; code: string }[] = [];
    const block = parseCardBlock(language, code, {
      incomplete,
      onInvalid: (errors) => issues.push(...errors),
    });
    return { block, issues };
  }, [language, code, incomplete]);
  React.useEffect(() => {
    if (incomplete || !import.meta.env.DEV || environment.preview) return;
    if (!block) {
      console.warn("[cards] invalid block", { language, issues });
    } else if (block.notices?.length) {
      console.warn("[cards] recovered block", {
        language,
        notices: block.notices,
      });
    }
  }, [block, issues, language, incomplete, environment.preview]);
  if (!block) {
    if (incomplete) return <CardSkeleton />;
    return (
      <CardShell>
        <p role="status" className="text-muted-foreground">
          {t(
            issues.some((issue) => issue.code === "empty")
              ? "chat.cardEmpty"
              : "chat.cardUnavailable",
          )}
        </p>
      </CardShell>
    );
  }
  return (
    <div className="min-w-0" data-card-type={block.type}>
      <CardContent block={block} />
      {"sourceRefs" in block.data && block.data.sourceRefs?.length ? (
        <CardSources refs={block.data.sourceRefs} />
      ) : null}
      {block.notices?.map((notice) => (
        <p
          key={notice}
          role="status"
          className="my-1 text-xs text-muted-foreground"
        >
          {t(`chat.cardNotice_${notice}`)}
        </p>
      ))}
    </div>
  );
}

function CardContent({ block }: { block: CardBlock }) {
  switch (block.type) {
    case "ui:artifact":
      return <ArtifactCard data={block.data} />;
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
