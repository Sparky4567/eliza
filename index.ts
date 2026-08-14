export * from "./src/index.ts";

if (import.meta.main) {
  const { createBot } = await import("./src/index.ts");
  const bot = createBot();
  await bot.startCLI();
}