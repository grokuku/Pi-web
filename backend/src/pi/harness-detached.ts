import type { SubagentEndStatus } from "./harness-stream.js";

/** Charge utile réinjectée à l'orchestrateur après un run détaché. */
export interface DetachedDelegationOutcome {
  status: SubagentEndStatus;
  cause: string | null;
  errorMessage: string | null;
  response: string;
  durationMs: number;
  actionCount: number;
}

interface DelegationRunResult {
  content?: Array<{ text?: string }>;
  details?: unknown;
}

function messageFromError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Erreur inattendue du sous-agent détaché";
}

/**
 * Termine un run détaché sans jamais laisser une rejection hors du `try`
 * disparaître : elle est journalisée ET réinjectée avec son vrai message.
 */
export function runDetachedDelegation(args: {
  run: () => Promise<DelegationRunResult>;
  postResult: (outcome: DetachedDelegationOutcome) => void;
  logger?: Pick<Console, "error">;
}): void {
  const logger = args.logger || console;
  void Promise.resolve()
    .then(args.run)
    .then((res) => {
      const details = (res?.details || {}) as {
        status?: SubagentEndStatus;
        cause?: string | null;
        errorMessage?: string | null;
        durationMs?: number;
        actionCount?: number;
      };
      const response = res?.content?.[0]?.text || "";
      const status = details.status || "error";
      args.postResult({
        status,
        cause: details.cause ?? null,
        errorMessage: status === "success" ? null : details.errorMessage || response || "Sous-agent en échec",
        response,
        durationMs: typeof details.durationMs === "number" ? details.durationMs : 0,
        actionCount: typeof details.actionCount === "number" ? details.actionCount : 0,
      });
    })
    .catch((error: unknown) => {
      const errorMessage = messageFromError(error);
      logger.error("[harness-orchestrator] Detached delegation failed:", error);
      args.postResult({
        status: "error",
        cause: "unexpected",
        errorMessage,
        response: "",
        durationMs: 0,
        actionCount: 0,
      });
    });
}
