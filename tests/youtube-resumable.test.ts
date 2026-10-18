import test from "node:test";
import assert from "node:assert/strict";
import { uploadResumableBytes } from "../src/lib/youtube-resumable";

const UNIT = 256 * 1024;
const completed = (videoId = "video123") =>
  new Response(JSON.stringify({ id: videoId }), { status: 201, headers: { "content-type": "application/json" } });
const incomplete = (range?: string) =>
  new Response(null, { status: 308, headers: range ? { range } : {} });

test("uploads a small video in one final resumable chunk", async () => {
  const ranges: string[] = [];
  const result = await uploadResumableBytes({
    uploadUrl: "https://upload.example/session",
    data: Uint8Array.of(1, 2, 3),
    contentType: "video/mp4",
    fetchImpl: async (_input, init) => {
      ranges.push(new Headers(init?.headers).get("content-range") || "");
      return completed();
    },
  });
  assert.deepEqual(result, { videoId: "video123" });
  assert.deepEqual(ranges, ["bytes 0-2/3"]);
});

test("sends multiple chunks with exact byte ranges", async () => {
  const ranges: string[] = [];
  let call = 0;
  const data = new Uint8Array(UNIT + 7);
  const result = await uploadResumableBytes({
    uploadUrl: "https://upload.example/session",
    data,
    contentType: "video/mp4",
    chunkSize: UNIT,
    fetchImpl: async (_input, init) => {
      ranges.push(new Headers(init?.headers).get("content-range") || "");
      call += 1;
      return call === 1 ? incomplete(`bytes=0-${UNIT - 1}`) : completed("video456");
    },
  });
  assert.deepEqual(result, { videoId: "video456" });
  assert.deepEqual(ranges, [`bytes 0-${UNIT - 1}/${data.length}`, `bytes ${UNIT}-${data.length - 1}/${data.length}`]);
});

test("checks session progress before resending after a network error", async () => {
  const ranges: string[] = [];
  let call = 0;
  const data = new Uint8Array(UNIT + 5);
  const result = await uploadResumableBytes({
    uploadUrl: "https://upload.example/session",
    data,
    contentType: "video/mp4",
    chunkSize: UNIT,
    fetchImpl: async (_input, init) => {
      call += 1;
      const headers = new Headers(init?.headers);
      ranges.push(headers.get("content-range") || "");
      if (call === 1) throw new Error("simulated connection reset after server accepted chunk");
      if (call === 2) return incomplete(`bytes=0-${UNIT - 1}`);
      return completed("video789");
    },
  });
  assert.deepEqual(result, { videoId: "video789" });
  assert.deepEqual(ranges, [
    `bytes 0-${UNIT - 1}/${data.length}`,
    `bytes */${data.length}`,
    `bytes ${UNIT}-${data.length - 1}/${data.length}`,
  ]);
});

test("reconciles a completed existing session without sending duplicate bytes", async () => {
  let calls = 0;
  const result = await uploadResumableBytes({
    uploadUrl: "https://upload.example/session",
    data: new Uint8Array(UNIT + 10),
    contentType: "video/mp4",
    chunkSize: UNIT,
    resume: true,
    fetchImpl: async (_input, init) => {
      calls += 1;
      assert.equal(new Headers(init?.headers).get("content-range"), `bytes */${UNIT + 10}`);
      return completed("alreadyUploaded");
    },
  });
  assert.deepEqual(result, { videoId: "alreadyUploaded" });
  assert.equal(calls, 1);
});

test("resumes an existing session from the server-acknowledged byte offset", async () => {
  const ranges: string[] = [];
  const data = new Uint8Array(UNIT + 9);
  let call = 0;
  const result = await uploadResumableBytes({
    uploadUrl: "https://upload.example/session",
    data,
    contentType: "video/mp4",
    chunkSize: UNIT,
    resume: true,
    fetchImpl: async (_input, init) => {
      call += 1;
      ranges.push(new Headers(init?.headers).get("content-range") || "");
      return call === 1 ? incomplete(`bytes=0-${UNIT - 1}`) : completed("resumedVideo");
    },
  });
  assert.deepEqual(result, { videoId: "resumedVideo" });
  assert.deepEqual(ranges, [`bytes */${data.length}`, `bytes ${UNIT}-${data.length - 1}/${data.length}`]);
});

test("does not retry permanent upload authorization errors", async () => {
  let calls = 0;
  await assert.rejects(
    uploadResumableBytes({
      uploadUrl: "https://upload.example/session",
      data: Uint8Array.of(1),
      contentType: "video/mp4",
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { message: "forbidden" } }), { status: 403 });
      },
    }),
    /HTTP 403/,
  );
  assert.equal(calls, 1);
});
