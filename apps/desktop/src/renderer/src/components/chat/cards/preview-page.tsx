import "@/i18n";
import "@/assets/globals.css";
import "streamdown/styles.css";
import * as React from "react";
import { Streamdown } from "streamdown";
import { Button } from "@/components/ui/button";
import { CardContext } from "./context";
import { cardRenderers } from "./renderers";

const plugins = { renderers: cardRenderers };
const longText =
  "这是一段较长的中文说明，用于检查窄窗口中的换行、折叠、展开和阅读体验。".repeat(
    16,
  );
const fixtures = [
  {
    title: "对比 · 未知枚举与推荐理由",
    language: "ui:compare",
    data: {
      title: "新手跑鞋对比",
      rows: [
        {
          name: "缓震慢跑鞋",
          pick: true,
          pickReason: "适合希望轻松开始跑步的新手。",
          attrs: [
            { label: "核心特点", value: "中底柔软厚实", tone: "good" },
            { label: "力量要求", value: "低" },
          ],
        },
        {
          name: "支撑慢跑鞋",
          note: "结合实际试穿感受选择。",
          attrs: [
            { label: "核心特点", value: "增加鞋底支撑", tone: "neutral" },
            { label: "力量要求", value: "低" },
          ],
        },
        {
          name: "竞速跑鞋",
          attrs: [
            { label: "核心特点", value: "轻量与回弹" },
            { label: "力量要求", value: "高", tone: "bad" },
          ],
        },
      ],
    },
  },
  {
    title: "长文本 · 展开后保留全文",
    language: "ui:note",
    data: { title: "使用说明", tone: "info", text: longText },
  },
  {
    title: "字段列表 · 丢弃损坏条目",
    language: "ui:kv_list",
    data: {
      title: "预订信息",
      items: [
        { label: "日期", value: "9 月 12 日" },
        { label: "损坏数据" },
        { label: "人数", value: "2 人", emphasis: "unknown" },
      ],
    },
  },
  {
    title: "统计 · 口径",
    language: "ui:stat",
    data: {
      title: "本月概览",
      items: [
        {
          label: "订单",
          value: "128",
          unit: "笔",
          description: "最近 30 天，不含退款",
          trendText: "+12%",
          trendTone: "good",
        },
        { label: "满意度", value: "96", unit: "%" },
      ],
    },
  },
  {
    title: "事件时间线",
    language: "ui:timeline",
    data: {
      title: "周末行程",
      steps: [
        { label: "出发", time: "09:00", status: "event" },
        { label: "午餐", time: "12:00", status: "event" },
      ],
    },
  },
  {
    title: "历史任务 · 进行中不旋转",
    language: "ui:timeline",
    data: {
      steps: [
        { label: "准备", status: "done" },
        { label: "处理", status: "active" },
        { label: "检查", status: "pending" },
      ],
    },
  },
  {
    title: "数值表格",
    language: "ui:table",
    data: {
      title: "方案费用",
      columns: ["方案", "费用"],
      emphasizeRowIndex: 0,
      rows: [
        { cells: ["基础", "100"], tone: "good" },
        { cells: ["进阶", "200"] },
      ],
    },
  },
  {
    title: "真实数据进度",
    language: "ui:progress",
    data: { label: "已上传 6 / 10 个文件", value: 60, tone: "unknown" },
  },
  {
    title: "柱状图 · 正负数与零",
    language: "ui:chart",
    data: {
      title: "每月结余",
      caption: "示例数据，用于检查零基线和键盘访问。",
      type: "bar",
      unit: "元",
      points: [
        { label: "一月", value: 1200 },
        { label: "二月", value: -800 },
        { label: "三月", value: 0 },
      ],
    },
  },
  {
    title: "折线图 · 单点",
    language: "ui:chart",
    data: {
      title: "单次测量",
      type: "line",
      points: [{ label: "今天", value: 12 }],
    },
  },
  {
    title: "成果 · 本地模拟记录",
    language: "ui:artifact",
    data: {
      artifactId: "preview-file",
      title: "旅行报告",
      description: "预览和保存按钮仅展示反馈，不访问文件。",
    },
  },
  {
    title: "追问 · 点击防重",
    language: "ui:suggestions",
    data: {
      items: [
        { label: "如何选择适合我的方案？" },
        { label: "能再详细解释一下吗？" },
      ],
    },
  },
  {
    title: "空图表 · 明确提示",
    language: "ui:chart",
    data: { type: "bar", points: [] },
  },
  {
    title: "必填枚举错误 · 明确提示",
    language: "ui:note",
    data: { tone: "unknown", text: "无法确定类型" },
  },
  {
    title: "超长列表 · 截断提示",
    language: "ui:compare",
    data: {
      rows: Array.from({ length: 22 }, (_, i) => ({ name: `选项 ${i + 1}` })),
    },
  },
];

export default function PreviewPage() {
  const [dark, setDark] = React.useState(false);
  const [narrow, setNarrow] = React.useState(false);
  const [streaming, setStreaming] = React.useState(false);
  const [position, setPosition] = React.useState(0);
  const stream =
    "```ui:compare\n" + JSON.stringify(fixtures[0].data, null, 2) + "\n```";
  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  React.useEffect(() => {
    if (!streaming || position >= stream.length) return;
    const timer = setInterval(
      () => setPosition((value) => Math.min(stream.length, value + 24)),
      80,
    );
    return () => clearInterval(timer);
  }, [streaming, stream.length, position]);
  const environment = React.useMemo(
    () => ({ streaming: false, preview: true, sessionId: null }),
    [],
  );
  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto flex max-w-5xl flex-col gap-5">
        <h1 className="text-xl font-semibold">动态组件预览</h1>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setDark(!dark)}>
            {dark ? "浅色" : "深色"}
          </Button>
          <Button variant="outline" onClick={() => setNarrow(!narrow)}>
            {narrow ? "宽窗口" : "窄窗口（360px）"}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setPosition(0);
              setStreaming(true);
            }}
          >
            播放流式输出
          </Button>
          <Button variant="outline" onClick={() => setStreaming(false)}>
            中断输出
          </Button>
        </div>
        <div
          className="flex w-full flex-col gap-6"
          style={{ maxWidth: narrow ? 360 : 760 }}
        >
          {position > 0 && (
            <section>
              <h2 className="mb-2 text-sm text-muted-foreground">流式输出</h2>
              <CardContext.Provider
                value={{
                  ...environment,
                  streaming: streaming && position < stream.length,
                }}
              >
                <Streamdown
                  plugins={plugins}
                  isAnimating={streaming && position < stream.length}
                >
                  {stream.slice(0, position)}
                </Streamdown>
              </CardContext.Provider>
            </section>
          )}
          <CardContext.Provider value={environment}>
            {fixtures.map((fixture) => (
              <section key={fixture.title}>
                <h2 className="mb-2 text-sm text-muted-foreground">
                  {fixture.title}
                </h2>
                <Streamdown plugins={plugins} isAnimating={false}>
                  {"```" +
                    fixture.language +
                    "\n" +
                    JSON.stringify(fixture.data) +
                    "\n```"}
                </Streamdown>
              </section>
            ))}
          </CardContext.Provider>
        </div>
      </div>
    </main>
  );
}
