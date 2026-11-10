// Load a rate CSV from the command line.
//   npm run import:rates -- --shop setu-store.myshopify.com --file rates.csv            (preview)
//   npm run import:rates -- --shop setu-store.myshopify.com --file rates.csv --commit   (apply)
//   add --replace to remove components not in the file for each HSN + country it lists
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { runRateImport } from "../app/lib/rates/import.server";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

const shop = value("shop");
const file = value("file");
if (!shop || !file) {
  console.error("Usage: npm run import:rates -- --shop <shop>.myshopify.com --file <rates.csv> [--commit] [--replace]");
  process.exit(1);
}

const db = new PrismaClient();
const report = await runRateImport(db, {
  shop, csvText: readFileSync(file, "utf8"), dryRun: !flag("commit"),
  mode: flag("replace") ? "replace_profiles" : "merge", actor: "cli", fileName: file,
});
await db.$disconnect();

for (const i of report.issues) console.log(`${i.severity.toUpperCase()} ${i.line > 1 ? `line ${i.line} ` : ""}${i.column ?? ""}: ${i.message}`);
console.log(JSON.stringify(report.summary, null, 2));
console.log(report.committed ? "Committed." : report.errorCount ? `Not applied: ${report.errorCount} error(s).` : "Preview only. Re-run with --commit to apply.");
process.exit(report.errorCount ? 1 : 0);
