import { registerHooks } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && error.code === "ERR_MODULE_NOT_FOUND")
        return next(`${specifier}.ts`, context);
      throw error;
    }
  },
});
const { parseCardBlock } = await import("./parse.ts");
const parse = (type, data, options) =>
  parseCardBlock(type, JSON.stringify(data), options);
const fixtures = [
  [
    "ui:compare",
    { rows: [{ name: "跑鞋", attrs: [{ label: "特点", value: "柔软" }] }] },
    (d) => d.rows[0].attrs[0],
    "tone",
    "good",
  ],
  [
    "ui:kv_list",
    { items: [{ label: "状态", value: "正常" }] },
    (d) => d.items[0],
    "emphasis",
    "bad",
  ],
  [
    "ui:stat",
    { items: [{ label: "人数", value: "3" }] },
    (d) => d.items[0],
    "trendTone",
    "neutral",
  ],
  [
    "ui:table",
    { columns: ["状态"], rows: [{ cells: ["正常"] }] },
    (d) => d.rows[0],
    "tone",
    "muted",
  ],
  ["ui:progress", { label: "进度", value: 50 }, (d) => d, "tone", "info"],
];
for (const [type, original, get, field, valid] of fixtures) {
  test(`${type}: optional enums preserve content in complete/streaming messages`, () => {
    for (const value of ["unknown", null, 42, false, {}, undefined, valid]) {
      const input = structuredClone(original);
      get(input)[field] = value;
      for (const incomplete of [false, true]) {
        const block = parse(type, input, { incomplete });
        if (type === "ui:progress" && incomplete) {
          assert.equal(block, null);
          continue;
        }
        assert.ok(block);
        const expected = structuredClone(input);
        get(expected)[field] = value === valid ? valid : undefined;
        assert.deepEqual(
          JSON.parse(JSON.stringify(block.data)),
          JSON.parse(JSON.stringify(expected)),
        );
      }
    }
  });
}
test("compare regression: third option with neutral tone stays present", () => {
  const rows = [
    { name: "缓震" },
    { name: "支撑" },
    {
      name: "竞速",
      attrs: [{ label: "特点", value: "碳板", tone: "neutral" }],
    },
  ];
  for (const incomplete of [false, true])
    assert.equal(
      parse("ui:compare", { rows }, { incomplete }).data.rows.length,
      3,
    );
});
test("nested and per-card limits truncate with a notice", () => {
  const rows = Array.from({ length: 21 }, () => ({
    name: "方案",
    attrs: Array.from({ length: 9 }, () => ({ label: "维度", value: "内容" })),
  }));
  const block = parse("ui:compare", { rows });
  assert.equal(block.data.rows.length, 20);
  assert.equal(block.data.rows[0].attrs.length, 8);
  assert.ok(block.notices.includes("truncated"));
});
test("independent invalid rows recover, including correct table emphasis", () => {
  const block = parse("ui:table", {
    columns: ["内容"],
    rows: [{ broken: true }, { cells: ["保留"] }],
    emphasizeRowIndex: 1,
  });
  assert.deepEqual(block.data.rows, [{ cells: ["保留"] }]);
  assert.equal(block.data.emphasizeRowIndex, 0);
  assert.ok(block.notices.includes("partial"));
});
test("bad chart points and timeline steps never silently disappear", () => {
  assert.equal(
    parse("ui:chart", {
      type: "bar",
      points: [
        { label: "一", value: 1 },
        { label: "二", value: "bad" },
        { label: "三", value: 3 },
      ],
    }),
    null,
  );
  assert.equal(
    parse("ui:timeline", {
      steps: [
        { label: "开始", status: "done" },
        { label: "未知", status: "bad" },
      ],
    }),
    null,
  );
});
test("empty completed arrays fail; incomplete chart remains recoverable", () => {
  assert.equal(parse("ui:chart", { type: "bar", points: [] }), null);
  assert.ok(
    parse("ui:chart", { type: "bar", points: [] }, { incomplete: true }),
  );
});
test("optional text is ignored, accepted long content is preserved", () => {
  const text = "较长的说明。".repeat(100);
  assert.equal(
    parse("ui:note", { tone: "info", title: {}, text }).data.text,
    text,
  );
});
test("required enums stay strict and diagnostics contain paths only", () => {
  let errors;
  assert.equal(
    parse(
      "ui:note",
      { tone: "private-value", text: "secret" },
      { onInvalid: (v) => (errors = v) },
    ),
    null,
  );
  assert.deepEqual(errors, [{ path: "tone", code: "invalid_value" }]);
});
test("unknown inherited language keys fail safely", () =>
  assert.equal(parse("toString", {}), null));
test("truncated final generation is visibly marked recovered", () => {
  const block = parseCardBlock(
    "ui:compare",
    '{"rows":[{"name":"A"},{"name":"B"',
  );
  assert.ok(block.notices.includes("recovered"));
  assert.equal(block.data.rows.length, 2);
});
test("event timelines and artifact references validate", () => {
  assert.ok(
    parse("ui:timeline", { steps: [{ label: "抵达", status: "event" }] }),
  );
  assert.ok(parse("ui:artifact", { artifactId: "write-123", title: "报告" }));
  assert.equal(parse("ui:artifact", { artifactId: "" }), null);
});
test("source references accept IDs but never model URLs", () => {
  assert.equal(
    parse("ui:stat", {
      items: [{ label: "数量", value: "1" }],
      sourceRefs: ["https://example.com"],
    }).data.sourceRefs,
    undefined,
  );
});
