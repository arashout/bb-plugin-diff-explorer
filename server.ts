import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract, rpcContract, type DiffFile } from "./contract";

const MONACO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "monaco");

export default async function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });

  async function environment(environmentId: string) {
    const env = await bb.sdk.environments.get({ environmentId });
    if (!env.path) throw new Error("This environment has no workspace path");
    if (!env.hostId) throw new Error("This environment has no host");
    return { root: env.path, hostId: env.hostId };
  }

  let preview: { baseUrl: string; expiresAtMs: number } | null = null;

  bb.rpc.register(rpcContract, {
    async assets() {
      if (preview === null || preview.expiresAtMs - Date.now() < 5 * 60_000) {
        preview = await bb.sdk.files.createPreview({ rootPath: MONACO_DIR, ttlMs: 60 * 60_000 });
      }
      return { baseUrl: preview.baseUrl };
    },

    async load({ threadId }) {
      const thread = await bb.sdk.threads.get({ threadId });
      if (!thread.environmentId) throw new Error("This thread has no environment");
      const environmentId = thread.environmentId;
      const { root } = await environment(environmentId);
      const diff = await bb.sdk.environments.diffFiles({ environmentId, target: "uncommitted" });
      if (diff.outcome !== "available") {
        throw new Error(diff.outcome === "unavailable" ? diff.failure.message : diff.message);
      }
      const side = async (filePath: string, which: "old" | "new") => {
        const result = await bb.sdk.environments.diffFile({
          environmentId,
          target: "uncommitted",
          path: filePath,
          side: which,
        });
        if (result.contentEncoding !== "utf8") throw new Error(`${filePath} is not text`);
        return result.content;
      };
      const textual = diff.files.filter((f) => !f.binary && f.loadMode !== "too_large");
      // ponytail: loads every file up front; lazy-load per file if big diffs get slow
      const files: DiffFile[] = await Promise.all(
        textual.map(async (f) => ({
          path: f.path,
          changeKind: f.changeKind,
          additions: f.additions,
          deletions: f.deletions,
          oldText: f.changeKind === "added" || f.origin === "untracked" ? "" : await side(f.previousPath ?? f.path, "old"),
          newText: f.changeKind === "deleted" ? "" : await side(f.path, "new"),
        })),
      );
      const skipped = diff.files.filter((f) => !textual.includes(f)).map((f) => f.path);
      return { environmentId, root, files, skipped };
    },

    async definition({ environmentId, ...position }) {
      const { root, hostId } = await environment(environmentId);
      return host.call("definition", { root, ...position }, { hostId });
    },

    async read({ environmentId, path: filePath }) {
      const { hostId } = await environment(environmentId);
      return host.call("read", { path: filePath }, { hostId });
    },
  });
}
