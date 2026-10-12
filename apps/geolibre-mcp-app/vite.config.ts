import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [viteSingleFile()],
  resolve: { dedupe: ["maplibre-gl", "react", "react-dom"] },
  worker: { format: "es" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: "show-map.html",
      treeshake: {
        moduleSideEffects: (id) =>
          !id.includes("maplibre-gl-components/dist") || id.endsWith(".css"),
      },
    },
  },
});
