const { EdgeTTS } = await import("@andresaya/edge-tts");
const tts = new EdgeTTS();
await tts.synthesize("Merhaba dünya, bu bir Edge tanı testidir.", "tr-TR-EmelNeural", undefined, {
  savePath: "/tmp/edge-test.mp3",
}).then(() => console.log("TANILAMA: BASARILI"))
  .catch((e) => console.log("TANILAMA: HATA —", e.message));
