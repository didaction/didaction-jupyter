import { expect, test } from "vitest";
import { readWorkspaceZip } from "./workspace-zip";
import { zipFixture } from "../../tests/fixtures/workspace-zip";

const read = (zip: Buffer) => readWorkspaceZip(Uint8Array.from(zip).buffer);
test.each([false, true])(
  "imports nested stored/deflated ZIP (%s)",
  async (deflate) => {
    const items = await read(
      zipFixture(
        [
          { name: "lesson/", text: "" },
          { name: "lesson/data.csv", text: "x,y\n1,42" },
        ],
        deflate,
      ),
    );
    expect(items.map((i) => i.path)).toEqual(["lesson", "lesson/data.csv"]);
    expect(new TextDecoder().decode(items[1]!.bytes)).toBe("x,y\n1,42");
  },
);
test.each([
  "../bad",
  "/absolute",
  "a/../../bad",
  ".env",
  "a/.hidden",
  "a\\bad",
  "a%2fb",
])("rejects unsafe ZIP path %s", async (name) => {
  await expect(read(zipFixture([{ name, text: "x" }]))).rejects.toThrow();
});
test("rejects duplicates, symlinks, corruption, oversize and excess entries", async () => {
  await expect(
    read(
      zipFixture([
        { name: "a", text: "" },
        { name: "a", text: "" },
      ]),
    ),
  ).rejects.toThrow();
  await expect(
    read(zipFixture([{ name: "link", text: "target", mode: 0xa000 }])),
  ).rejects.toThrow();
  const corrupt = zipFixture([{ name: "a", text: "payload" }]);
  corrupt[31] = 0;
  await expect(read(corrupt)).rejects.toThrow();
  await expect(
    read(zipFixture([{ name: "a", text: "x".repeat(1_000_001) }], true)),
  ).rejects.toThrow();
  await expect(
    read(
      zipFixture(
        Array.from({ length: 1001 }, (_, i) => ({ name: String(i), text: "" })),
      ),
    ),
  ).rejects.toThrow();
});
test("rejects truncated and encrypted archives", async () => {
  const zip = zipFixture([{ name: "a", text: "data" }]);
  await expect(read(zip.subarray(0, zip.length - 1))).rejects.toThrow();
  zip.writeUInt16LE(1, 35 + 8);
  await expect(read(zip)).rejects.toThrow();
});
