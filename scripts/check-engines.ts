// Kiểm tra nhanh các engine chạy bằng gói subscription trên máy này:
//   npx tsx scripts/check-engines.ts [codex|claude-code ...] [--ask "câu hỏi"]
import { checkEngine, createEngine, type EngineKind } from "../src/engines/index.js";

const argv = process.argv.slice(2);
const askAt = argv.indexOf("--ask");
const question = askAt >= 0 ? argv[askAt + 1] : undefined;
const named = (askAt >= 0 ? argv.slice(0, askAt) : argv) as EngineKind[];
const kinds = named.length ? named : (["codex", "claude-code"] as EngineKind[]);

for (const kind of kinds) {
  if (question) {
    const reply = await createEngine({ kind }).generate({ messages: [{ role: "user", content: question }] });
    console.log(`--- ${kind}\n${reply}`);
  } else {
    console.log(kind, JSON.stringify(await checkEngine({ kind })));
  }
}
