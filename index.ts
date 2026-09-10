export * from "./src/index.ts";

if (import.meta.main) {
  const { main } = await import("./src/index.ts");
  await main();
}
