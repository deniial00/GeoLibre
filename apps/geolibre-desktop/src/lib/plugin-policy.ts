import type { DeploymentPolicy } from "./deployment-policy";

export type PluginSource =
  | "registry"
  | "manifest-url"
  | "zip"
  | "directory"
  | "project-file"
  | "bundled";

export type PluginDecision = { allowed: true } | { allowed: false; reason: string };

/** Deployment policy gates external code, not built-in plugin registration. */
export function evaluatePlugin(
  id: string,
  source: PluginSource,
  policy: DeploymentPolicy | null,
): PluginDecision {
  const plugins = policy?.plugins;
  if (!plugins) return { allowed: true };
  if (plugins.sideload === false && source !== "registry" && source !== "bundled") {
    return { allowed: false, reason: "Plugin sideloading is disabled by deployment policy." };
  }
  if (plugins.blocked?.includes(id)) {
    return { allowed: false, reason: `Plugin '${id}' is blocked by deployment policy.` };
  }
  if (source !== "bundled" && plugins.allowed !== undefined && !plugins.allowed.includes(id)) {
    return { allowed: false, reason: `Plugin '${id}' is not allowed by deployment policy.` };
  }
  return { allowed: true };
}
