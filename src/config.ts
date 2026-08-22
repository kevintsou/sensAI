import * as fs from "fs";
import * as path from "path";
import * as YAML from "yaml";

/**
 * 專案層級設定（`.sensai/config.yaml`，進版控）。
 *
 * 只放團隊共同的決定 —— 目前就是隱私閘門。每台機器各自的設定
 * （CCR 位址、model、逾時）走 VS Code settings，不放這裡。
 */
export interface ProjectConfig {
  privacy: {
    neverSend: string[];
    auditLog: string | null;
  };
}

const DEFAULTS: ProjectConfig = {
  privacy: { neverSend: [], auditLog: null },
};

export function loadProjectConfig(workspaceRoot: string): ProjectConfig {
  const file = path.join(workspaceRoot, ".sensai", "config.yaml");
  if (!fs.existsSync(file)) {
    return DEFAULTS;
  }
  let doc: unknown;
  try {
    doc = YAML.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`.sensai/config.yaml 解析失敗: ${(err as Error).message}`);
  }
  const privacy = (doc as any)?.privacy ?? {};
  return {
    privacy: {
      neverSend: Array.isArray(privacy.never_send) ? privacy.never_send.map(String) : [],
      auditLog: typeof privacy.audit_log === "string" ? privacy.audit_log : null,
    },
  };
}
